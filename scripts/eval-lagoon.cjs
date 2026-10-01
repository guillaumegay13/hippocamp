#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const memory = require("./hippocamp-memory.cjs");

const MAX_TOP_K = 20;
const DEFAULT_CASES = "evals/retrieval-cases.json";

function printHelp() {
  console.log(`Hippocamp Lagoon eval

Read-only retrieval check against your real Lagoon. No model or API key is used.
Each case names a project, a query, and the event ids that answer it.
An empty expect list means no memory should be returned.

Usage:
  npm run eval:lagoon -- [--cases PATH] [--top-k K]

Options:
  --cases PATH  Cases JSON. Default: <Lagoon root>/${DEFAULT_CASES}
  --top-k K     Results retrieved per query, at most ${MAX_TOP_K}. Default: 5
  --help        Show this help

Cases file:
  { "cases": [ { "project": "<slug>", "query": "...", "expect": ["<event id>"] } ] }
`);
}

function parseArgs(argv) {
  const options = { cases: path.join(memory.getGlobalRoot(), DEFAULT_CASES), topK: 5, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token === "--cases") {
      options.cases = argv[++index];
    } else if (token === "--top-k") {
      const number = Number(argv[++index]);

      if (!Number.isInteger(number) || number < 1 || number > MAX_TOP_K) {
        throw new Error(`--top-k must be an integer from 1 to ${MAX_TOP_K}.`);
      }

      options.topK = number;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

async function run(options) {
  if (!fsSync.existsSync(options.cases)) {
    throw new Error(`Missing ${options.cases}. Run with --help for the file format.`);
  }

  const { cases } = JSON.parse(await fs.readFile(options.cases, "utf8"));
  // searchMemory derives the project slug from the folder name, so a bare temp
  // folder per slug reads that project's memory without touching any real repo.
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-eval-lagoon-"));
  const answerable = { count: 0, hit: 0, mrr: 0, chars: 0, topScores: [] };
  const empty = { count: 0, correct: 0, topScores: [] };

  try {
    for (const item of cases) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(String(item.project))) {
        throw new Error(`Invalid project slug: ${item.project}`);
      }

      const projectRoot = path.join(sandboxRoot, item.project);
      await fs.mkdir(projectRoot, { recursive: true });

      const search = await memory.searchMemory({
        query: item.query,
        scope: "project",
        projectRoot,
        maxResults: options.topK,
      });
      const topScore = search.results[0]?.score ?? 0;

      if (!item.expect.length) {
        empty.count += 1;
        empty.correct += search.results.length ? 0 : 1;
        empty.topScores.push(topScore);
        console.log(`${search.results.length ? "MISS" : "ok  "}  empty   top ${topScore}  [${item.project}] ${item.query}`);
        continue;
      }

      const rank = search.results.findIndex((result) => item.expect.includes(result.id));
      answerable.count += 1;
      answerable.hit += rank === -1 ? 0 : 1;
      answerable.mrr += rank === -1 ? 0 : 1 / (rank + 1);
      answerable.chars += search.results.reduce((sum, result) => sum + result.snippet.length, 0);
      answerable.topScores.push(topScore);
      console.log(
        `${rank === -1 ? "MISS" : "ok  "}  rank ${rank === -1 ? "-" : rank + 1}  top ${topScore}  [${item.project}] ${item.query}`,
      );
    }
  } finally {
    await fs.rm(sandboxRoot, { recursive: true, force: true });
  }

  const percent = (part, whole) => `${((part / Math.max(whole, 1)) * 100).toFixed(1)}%`;
  const range = (scores) => (scores.length ? `${Math.min(...scores)}-${Math.max(...scores)}` : "n/a");

  console.log(`\nLagoon retrieval, K=${options.topK}, ${cases.length} cases`);
  console.log(
    `answerable (${answerable.count})  Hit@K ${percent(answerable.hit, answerable.count)}  MRR ${(answerable.mrr / Math.max(answerable.count, 1)).toFixed(3)}  context ${Math.round(answerable.chars / Math.max(answerable.count, 1))} chars  top score ${range(answerable.topScores)}`,
  );
  console.log(
    `no memory  (${empty.count})  empty result ${percent(empty.correct, empty.count)}  top score ${range(empty.topScores)}`,
  );
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
