#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const memory = require("./hippocamp-memory.cjs");

const DEFAULT_DATA = ".context/longmemeval/longmemeval_s_cleaned.json";
const DEFAULT_CACHE = ".context/qa-results.jsonl";
const DEFAULT_SYSTEMS = "hippocamp,oracle";
const SYSTEMS = ["hippocamp", "hippocamp-k10", "oracle"];
const DATA_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

// Prompts are verbatim from the official LongMemEval repo (xiaowu0162/LongMemEval):
// src/generation/run_generation.py for the reader, src/evaluation/evaluate_qa.py for the grader.
const READER_PROMPT =
  "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer (step by step):";

const BASE_CHECK =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. ";
const GRADER_PROMPTS = {
  "single-session-user": `${BASE_CHECK}\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.`,
  "single-session-assistant": `${BASE_CHECK}\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.`,
  "multi-session": `${BASE_CHECK}\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.`,
  "temporal-reasoning": `${BASE_CHECK}In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.`,
  "knowledge-update":
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
  "single-session-preference":
    "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.",
};

function printHelp() {
  console.log(`Hippocamp QA eval

LongMemEval-S answer accuracy. A reader model answers each question from the
retrieved history, and a grader model checks the answer, both with the official
LongMemEval prompts. Calls go to an OpenAI-compatible chat completions endpoint.

Systems:
  hippocamp       searchMemory top 5 snippets
  hippocamp-k10   searchMemory top 10 snippets
  oracle          the labeled answer sessions, in full

Usage:
  npm run eval:qa -- [--data PATH] [--limit N] [--systems LIST] [--cache PATH] [--dry-run]

Options:
  --data PATH      LongMemEval-S JSON. Default: ${DEFAULT_DATA}
  --limit N        Evaluate N questions spread evenly across the set. Default: all answerable questions
  --systems LIST   Comma-separated systems. Default: ${DEFAULT_SYSTEMS}
  --cache PATH     JSONL results cache; reruns only pay for missing calls. Default: ${DEFAULT_CACHE}
  --concurrency N  Parallel reader and grader calls. Default: 6
  --dry-run        Print jobs and prompt token estimates without any API call
  --help           Show this help

Environment:
  MANIFEST_BASE_URL, MANIFEST_API_KEY   OpenAI-compatible endpoint and key
  QA_READER_MODEL                       Default: anthropic/claude-sonnet-5
  QA_GRADER_MODEL                       Default: openrouter/openai/gpt-4o

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
  const options = {
    data: DEFAULT_DATA,
    limit: null,
    systems: DEFAULT_SYSTEMS.split(","),
    cache: DEFAULT_CACHE,
    concurrency: 6,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token === "--data") {
      options.data = argv[++index];
    } else if (token === "--limit") {
      options.limit = parsePositiveInteger(argv[++index], "--limit");
    } else if (token === "--systems") {
      options.systems = String(argv[++index] || "").split(",").filter(Boolean);

      for (const system of options.systems) {
        if (!SYSTEMS.includes(system)) {
          throw new Error(`Unknown system: ${system}. Use ${SYSTEMS.join(", ")}.`);
        }
      }
    } else if (token === "--cache") {
      options.cache = argv[++index];
    } else if (token === "--concurrency") {
      options.concurrency = parsePositiveInteger(argv[++index], "--concurrency");
    } else if (token === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function fill(template, ...values) {
  return values.reduce((text, value) => text.replace("{}", () => String(value)), template);
}

function formatSession(sessionId, date, turns) {
  const lines = [`# Session ${sessionId}`, "", `Date: ${date || "unknown"}`, ""];

  for (const turn of turns || []) {
    lines.push(`## ${turn.role === "assistant" ? "Assistant" : "User"}`, "", String(turn.content || "").trim(), "");
  }

  return `${lines.join("\n").trim()}\n`;
}

function historyString(chunks) {
  return chunks
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((chunk, index) => `\n### Session ${index + 1}:\nSession Date: ${chunk.date}\nSession Content:\n${chunk.content}\n`)
    .join("");
}

async function hippocampChunks(item, projectRoot, maxResults) {
  const pathToIndex = new Map();

  for (let index = 0; index < item.haystack_sessions.length; index += 1) {
    const relativePath = `sessions/${String(index).padStart(4, "0")}.md`;
    const content = formatSession(item.haystack_session_ids[index], item.haystack_dates[index], item.haystack_sessions[index]);

    await memory.writeMemoryFile({ scope: "project", path: relativePath, content, projectRoot, sync: false });
    pathToIndex.set(relativePath, index);
  }

  const search = await memory.searchMemory({ query: item.question, scope: "project", projectRoot, maxResults });

  return search.results.map((result) => ({
    date: item.haystack_dates[pathToIndex.get(result.path)],
    content: `\n${result.snippet}`,
  }));
}

function oracleChunks(item) {
  const answerIds = new Set(item.answer_session_ids.map(String));

  return item.haystack_sessions
    .map((turns, index) => ({ id: String(item.haystack_session_ids[index]), date: item.haystack_dates[index], turns }))
    .filter((session) => answerIds.has(session.id))
    .map((session) => ({
      date: session.date,
      content: `\n${JSON.stringify(session.turns.map(({ role, content }) => ({ role, content })))}`,
    }));
}

async function chat(endpoint, model, content, maxTokens) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.MANIFEST_API_KEY}`, "Content-Type": "application/json" },
        // No temperature: Claude 5 models reject it. The official runs use 0.
        body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: maxTokens }),
      });
      const text = await response.text();

      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
      }

      return JSON.parse(text).choices[0].message.content || "";
    } catch (error) {
      const retryable = !error.status || error.status === 429 || error.status >= 500;

      if (!retryable || attempt >= 5) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function percent(rows) {
  return `${((rows.filter((row) => row.correct).length / Math.max(rows.length, 1)) * 100).toFixed(1)}%`;
}

async function run(options) {
  if (!fsSync.existsSync(options.data)) {
    throw new Error(`Missing ${options.data}. Run with --help for the download command.`);
  }

  const reader = process.env.QA_READER_MODEL || "anthropic/claude-sonnet-5";
  const grader = process.env.QA_GRADER_MODEL || "openrouter/openai/gpt-4o";
  const baseUrl = String(process.env.MANIFEST_BASE_URL || "").replace(/\/+$/, "");
  const endpoint = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/chat/completions`;
  const key = (system, id) => `${system}|${reader}|${grader}|${id}`;

  const answerable = JSON.parse(await fs.readFile(options.data, "utf8")).filter(
    (item) => !String(item.question_id).endsWith("_abs"),
  );
  const limit = Math.min(options.limit || answerable.length, answerable.length);
  const items = Array.from({ length: limit }, (_, index) => answerable[Math.floor((index * answerable.length) / limit)]);
  const done = new Map();

  if (fsSync.existsSync(options.cache)) {
    for (const line of (await fs.readFile(options.cache, "utf8")).split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      done.set(`${row.system}|${row.reader}|${row.grader}|${row.id}`, row);
    }
  }

  // Build every prompt first (retrieval is local and sequential), then call models concurrently.
  const jobs = [];
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-eval-qa-"));
  const previousGlobalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(sandboxRoot, "lagoon");

  try {
    for (const [position, item] of items.entries()) {
      const projectRoot = path.join(sandboxRoot, "questions", String(position));

      for (const system of options.systems) {
        if (done.has(key(system, item.question_id))) {
          continue;
        }

        const chunks =
          system === "oracle" ? oracleChunks(item) : await hippocampChunks(item, projectRoot, system === "hippocamp-k10" ? 10 : 5);
        jobs.push({ system, item, prompt: fill(READER_PROMPT, historyString(chunks), item.question_date, item.question) });
      }

      await fs.rm(process.env.HIPPOCAMP_GLOBAL_ROOT, { recursive: true, force: true });
    }
  } finally {
    if (previousGlobalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = previousGlobalRoot;
    }

    await fs.rm(sandboxRoot, { recursive: true, force: true });
  }

  console.error(`${items.length} questions, ${jobs.length} new jobs; reader ${reader}, grader ${grader}`);

  for (const system of options.systems) {
    const chars = jobs.filter((job) => job.system === system).reduce((sum, job) => sum + job.prompt.length, 0);
    console.error(`  ${system}: ${Math.round(chars / 4)} reader prompt tokens (estimate)`);
  }

  if (options.dryRun) {
    return;
  }

  if (jobs.length && (!baseUrl || !process.env.MANIFEST_API_KEY)) {
    throw new Error("Set MANIFEST_BASE_URL and MANIFEST_API_KEY.");
  }

  await fs.mkdir(path.dirname(path.resolve(options.cache)), { recursive: true });
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const response = await chat(endpoint, reader, job.prompt, 800);
      const verdict = await chat(
        endpoint,
        grader,
        fill(GRADER_PROMPTS[job.item.question_type], job.item.question, job.item.answer, response),
        10,
      );
      const row = {
        system: job.system,
        reader,
        grader,
        id: job.item.question_id,
        type: job.item.question_type,
        correct: /yes/i.test(verdict),
        contextChars: job.prompt.length,
        response,
      };

      await fs.appendFile(options.cache, `${JSON.stringify(row)}\n`);
      done.set(key(row.system, row.id), row);

      if (++finished % 20 === 0) {
        console.error(`progress ${finished}/${jobs.length}`);
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));

  console.log(`LongMemEval-S QA, ${items.length} answerable questions, reader ${reader}, grader ${grader}\n`);

  for (const system of options.systems) {
    const rows = items.map((item) => done.get(key(system, item.question_id))).filter(Boolean);
    const contextChars = Math.round(rows.reduce((sum, row) => sum + row.contextChars, 0) / Math.max(rows.length, 1));
    console.log(`${system.padEnd(14)} QA ${percent(rows)}  (${rows.length} graded, prompt ${contextChars} chars)`);
  }

  for (const system of options.systems) {
    const rows = items.map((item) => done.get(key(system, item.question_id))).filter(Boolean);
    console.log(`\n${system}`);

    for (const type of [...new Set(rows.map((row) => row.type))].sort()) {
      const byType = rows.filter((row) => row.type === type);
      console.log(`  ${type.padEnd(26)} ${percent(byType).padStart(6)}  (${byType.length})`);
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
