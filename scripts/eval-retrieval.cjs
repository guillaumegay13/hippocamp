#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const memory = require("./hippocamp-memory.cjs");

const MAX_TOP_K = 20;
const DEFAULT_DATA = ".context/longmemeval/longmemeval_s_cleaned.json";
const DATA_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

function printHelp() {
  console.log(`Hippocamp retrieval eval

Retrieval-only LongMemEval-S check. No model or API key is used.
Each question's sessions are written as memory files in a temporary Lagoon,
then searchMemory and an in-process BM25 reference retrieve the top K.

Usage:
  npm run eval:retrieval -- [--data PATH] [--limit N] [--top-k K]

Options:
  --data PATH   LongMemEval-S JSON. Default: ${DEFAULT_DATA}
  --limit N     Evaluate N questions spread evenly across the set. Default: all answerable questions
  --top-k K     Results retrieved per question, at most ${MAX_TOP_K} (the search_memory cap). Default: 5
  --help        Show this help

Download the data once:
  mkdir -p .context/longmemeval
  curl -L -o ${DEFAULT_DATA} \\
    ${DATA_URL}
`);
}

function parsePositiveInteger(value, name) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return number;
}

function parseArgs(argv) {
  const options = { data: DEFAULT_DATA, limit: null, topK: 5, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token === "--data") {
      options.data = argv[++index];
    } else if (token === "--limit") {
      options.limit = parsePositiveInteger(argv[++index], "--limit");
    } else if (token === "--top-k") {
      options.topK = parsePositiveInteger(argv[++index], "--top-k");

      if (options.topK > MAX_TOP_K) {
        throw new Error(`--top-k must be at most ${MAX_TOP_K}, the search_memory result cap.`);
      }
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function formatSession(sessionId, date, turns) {
  const lines = [`# Session ${sessionId}`, "", `Date: ${date || "unknown"}`, ""];

  for (const turn of turns || []) {
    lines.push(`## ${turn.role === "assistant" ? "Assistant" : "User"}`, "", String(turn.content || "").trim(), "");
  }

  return `${lines.join("\n").trim()}\n`;
}

function tokenize(value) {
  return (
    String(value || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  );
}

function rankBm25(query, documents) {
  const tokenized = documents.map((document) => tokenize(document.content));
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(tokenized.length, 1);
  const documentFrequency = new Map();

  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const queryTokens = [...new Set(tokenize(query))];

  return documents
    .map((document, index) => {
      const frequencies = new Map();

      for (const token of tokenized[index]) {
        frequencies.set(token, (frequencies.get(token) || 0) + 1);
      }

      let score = 0;

      for (const token of queryTokens) {
        const frequency = frequencies.get(token) || 0;

        if (!frequency) {
          continue;
        }

        const matching = documentFrequency.get(token);
        const idf = Math.log(1 + (documents.length - matching + 0.5) / (matching + 0.5));
        const lengthRatio = tokenized[index].length / Math.max(averageLength, 1);
        score += idf * ((frequency * 2.5) / (frequency + 1.5 * (0.25 + 0.75 * lengthRatio)));
      }

      return { document, score };
    })
    .sort((left, right) => right.score - left.score || left.document.index - right.document.index)
    .map((item) => item.document);
}

function retrievalMetrics(retrievedIds, answerIds) {
  const expected = new Set(answerIds);
  const hits = retrievedIds.filter((id) => expected.has(id)).length;
  const firstRank = retrievedIds.findIndex((id) => expected.has(id));

  return {
    recall: hits / expected.size,
    hit: hits ? 1 : 0,
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
  };
}

function addMetrics(bucket, system, metrics) {
  const total = (bucket[system] ||= { recall: 0, hit: 0, mrr: 0, contextChars: 0, latencyMs: 0, count: 0 });

  for (const key of ["recall", "hit", "mrr", "contextChars", "latencyMs"]) {
    total[key] += metrics[key];
  }

  total.count += 1;
}

function formatRow(label, total) {
  const average = (key) => total[key] / total.count;

  return [
    label.padEnd(12),
    `Recall@K ${(average("recall") * 100).toFixed(1)}%`,
    `Hit@K ${(average("hit") * 100).toFixed(1)}%`,
    `MRR ${average("mrr").toFixed(3)}`,
    `context ${Math.round(average("contextChars"))} chars`,
    `latency ${average("latencyMs").toFixed(0)} ms`,
  ].join("  ");
}

async function run(options) {
  if (!fsSync.existsSync(options.data)) {
    throw new Error(`Missing ${options.data}. Run with --help for the download command.`);
  }

  const answerable = JSON.parse(await fs.readFile(options.data, "utf8")).filter(
    (item) => !String(item.question_id).endsWith("_abs"),
  );
  const limit = Math.min(options.limit || answerable.length, answerable.length);
  const items = Array.from({ length: limit }, (_, index) => answerable[Math.floor((index * answerable.length) / limit)]);
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-eval-retrieval-"));
  const previousGlobalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const overall = {};
  const byType = {};

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(sandboxRoot, "lagoon");

  try {
    for (const [position, item] of items.entries()) {
      const projectRoot = path.join(sandboxRoot, "questions", String(position));
      const documents = [];
      const pathToSessionId = new Map();

      for (let index = 0; index < item.haystack_sessions.length; index += 1) {
        const sessionId = String(item.haystack_session_ids[index]);
        const relativePath = `sessions/${String(index).padStart(4, "0")}.md`;
        const content = formatSession(sessionId, item.haystack_dates[index], item.haystack_sessions[index]);

        await memory.writeMemoryFile({ scope: "project", path: relativePath, content, projectRoot, sync: false });
        documents.push({ index, content, sessionId });
        pathToSessionId.set(relativePath, sessionId);
      }

      const answerIds = item.answer_session_ids.map(String);
      let startedAt = performance.now();
      const search = await memory.searchMemory({
        query: item.question,
        scope: "project",
        projectRoot,
        maxResults: options.topK,
      });
      const hippocamp = {
        ...retrievalMetrics(search.results.map((result) => pathToSessionId.get(result.path)), answerIds),
        latencyMs: performance.now() - startedAt,
        contextChars: search.results.reduce((sum, result) => sum + result.snippet.length, 0),
      };

      startedAt = performance.now();
      const bm25Documents = rankBm25(item.question, documents).slice(0, options.topK);
      const bm25 = {
        ...retrievalMetrics(bm25Documents.map((document) => document.sessionId), answerIds),
        latencyMs: performance.now() - startedAt,
        contextChars: bm25Documents.reduce((sum, document) => sum + document.content.length, 0),
      };

      for (const bucket of [overall, (byType[item.question_type] ||= {})]) {
        addMetrics(bucket, "hippocamp", hippocamp);
        addMetrics(bucket, "bm25", bm25);
      }

      await fs.rm(process.env.HIPPOCAMP_GLOBAL_ROOT, { recursive: true, force: true });

      if ((position + 1) % 50 === 0) {
        console.error(`progress ${position + 1}/${items.length}`);
      }
    }
  } finally {
    if (previousGlobalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = previousGlobalRoot;
    }

    await fs.rm(sandboxRoot, { recursive: true, force: true });
  }

  console.log(`LongMemEval-S retrieval, ${items.length} answerable questions, K=${options.topK}`);
  console.log("bm25 returns whole sessions; hippocamp returns bounded snippets.\n");

  for (const [system, total] of Object.entries(overall)) {
    console.log(formatRow(system, total));
  }

  for (const [type, systems] of Object.entries(byType)) {
    console.log(`\n${type} (${systems.bm25.count})`);

    for (const [system, total] of Object.entries(systems)) {
      console.log(`  ${formatRow(system, total)}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  await run(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
