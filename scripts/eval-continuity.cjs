#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn: spawnChild } = require("node:child_process");
const { promisify } = require("node:util");
const { factDistance, loadDataset, validateDataset } = require("./continuity-dataset.cjs");
const { complete: completeModel } = require("./eval-locomo.cjs");
const { attributeMisses, blindDigest, blindText, judgeMemory, judgeProbe, transcriptDigest } = require("./continuity-judge.cjs");
const { bootstrapDiff, breakdownTable, efficiencyTable, qualityTable, summarize, validationSheet } = require("./continuity-report.cjs");
const { ADAPTERS, ARMS, AUTO_LOADED, GIT_IDENTITY, MODEL, resolveArm } = require("./continuity-adapters.cjs");

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const DATASET_DIR = path.join(REPO_ROOT, "bench", "continuity");
const RESULTS_DIR = path.join(REPO_ROOT, ".context", "continuity");
// Rough $ per Opus session, before the smoke run measures it.
const SESSION_COST_RANGE = [0.3, 1.5];
const SYSTEMS = ARMS;

// Claude Code loads CLAUDE.md (and .claude/CLAUDE.md) from every parent folder, so sandboxes live in a
// neutral folder outside this repo and outside HOME, whose ~/.claude/CLAUDE.md would otherwise load in
// every arm. /var/tmp survives reboots, unlike the macOS temp dir, so runs can be resumed days later.
function benchRoot(env = process.env) {
  return env.HIPPOCAMP_BENCH_DIR || "/var/tmp/agent-bench";
}

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", path.join(".claude", "CLAUDE.md"), path.join(".claude", "rules")];

function assertNoInstructionFiles(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const found = INSTRUCTION_FILES.map((file) => path.join(current, file)).find((file) => fsSync.existsSync(file));

    if (found) {
      throw new Error(`Agent instructions at ${found} would load in every sandbox below it; set HIPPOCAMP_BENCH_DIR elsewhere`);
    }

    if (path.dirname(current) === current) {
      return;
    }
  }
}

function sandboxPaths(runId, system, env = process.env) {
  const base = benchRoot(env);
  fsSync.mkdirSync(base, { recursive: true });
  // Resolved, because Claude Code reports its cwd and file paths through symlinks such as macOS /var -> /private/var.
  // An opaque folder per arm: Claude Code names native memory after the working folder, and the agent and
  // the judge both see paths, so no path may name the arm.
  const root = path.join(fsSync.realpathSync(base), runId, `s-${crypto.createHash("sha256").update(system).digest("hex").slice(0, 10)}`);
  const home = path.join(root, "home");

  return {
    root,
    home,
    configDir: path.join(home, ".claude"),
    lagoon: path.join(root, "lagoon"),
    repos: { relay: path.join(root, "repos", "relay"), ingest: path.join(root, "repos", "ingest") },
    mcpConfig: path.join(root, "mcp.json"),
  };
}

// Background auto-maintenance would keep writing in a sandbox repo after the call returns.
async function git(args, cwd) {
  return execFileAsync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd, env: { ...process.env, ...GIT_IDENTITY }, maxBuffer: 64 * 1024 * 1024 });
}

async function prepareSandbox(dataset, paths, system, { install = true, adapterSpawn } = {}) {
  const marker = path.join(paths.root, ".prepared");

  if (fsSync.existsSync(marker)) {
    return;
  }

  await fs.rm(paths.root, { recursive: true, force: true });
  await fs.mkdir(paths.configDir, { recursive: true });

  for (const [project, repo] of Object.entries(paths.repos)) {
    await fs.cp(dataset.seeds[project], repo, { recursive: true });

    if (install && fsSync.existsSync(path.join(repo, "package.json"))) {
      await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: repo });
    }

    await git(["init", "-q", "-b", "main"], repo);
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "seed"], repo);
  }

  await ADAPTERS[resolveArm(system)].prepare(paths, { spawn: adapterSpawn });

  await fs.writeFile(marker, `${new Date().toISOString()}\n`);
}

// Records without their sandbox would mean later sessions run with no history while results look valid.
async function assertSandboxIntact(paths, systemDir) {
  const records = (await fs.readdir(systemDir).catch(() => [])).filter((name) => name.endsWith(".json"));

  if (records.length && !fsSync.existsSync(path.join(paths.root, ".prepared"))) {
    throw new Error(`${systemDir} has session results but its sandbox ${paths.root} is gone. Start a new --run.`);
  }
}

function claudeEnv(system, paths, baseEnv = process.env) {
  return ADAPTERS[resolveArm(system)].env(paths, baseEnv);
}

function claudeArgs({ system, ...options }) {
  return ADAPTERS[resolveArm(system)].args(options);
}

function parseStream(text) {
  const parsed = { costUsd: 0, ok: false, toolCalls: [], finalText: "", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0 };

  for (const line of text.split("\n")) {
    let event;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "tool_use") {
          parsed.toolCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }

    if (event.type === "user") {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        const call = block.type === "tool_result" && parsed.toolCalls.find((entry) => entry.id === block.tool_use_id);

        if (call) {
          call.result = typeof block.content === "string" ? block.content : (block.content || []).map((part) => part.text || "").join("");
          call.resultBytes = Buffer.byteLength(call.result);
        }
      }
    }

    if (event.type === "result") {
      parsed.costUsd += event.total_cost_usd || 0;
      parsed.durationMs += event.duration_ms || 0;
      parsed.tokens.input += event.usage?.input_tokens || 0;
      parsed.tokens.output += event.usage?.output_tokens || 0;
      parsed.tokens.cacheRead += event.usage?.cache_read_input_tokens || 0;
      parsed.tokens.cacheWrite += event.usage?.cache_creation_input_tokens || 0;
      parsed.ok = event.is_error === false && event.subtype === "success";
      parsed.limited = event.api_error_status === 429;
      parsed.finalText = typeof event.result === "string" ? event.result : "";
    }
  }

  return parsed;
}

function spawnClaude(command, args, { input, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { ...options, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });

    if (input !== undefined) {
      child.stdin.end(input);
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function head(repo) {
  return (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
}

// Runs the timeline in order, one fresh claude process per session (follow-up turns resume it).
// Each finished session writes <id>.json last, so a rerun skips it and never commits twice.
// Probe sessions first save what memory held at their start, for the judge's miss attribution.
function sessionFingerprint(session) {
  return crypto.createHash("sha256").update(JSON.stringify({ turns: session.turns, checklist: session.checklist })).digest("hex").slice(0, 16);
}

// First line of the agent's own summary, as a person would write the commit.
function commitMessage(id, finalText) {
  const line = String(finalText)
    .split("\n")
    .map((text) => text.replace(/[*_`#>]/g, "").trim())
    .find(Boolean);

  if (!line) {
    return id;
  }

  const subject = line.length <= 72 ? line : line.slice(0, 72).replace(/\s+\S*$/, "");
  return `${subject}\n\nSession ${id}`;
}

// Whether the agent's final message offers or asks something a user would answer.
function isOffer(finalText) {
  const prose = String(finalText).replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").trim();
  const last = prose.split(/\n\s*\n/).pop() || "";
  return /\?\s*$/.test(last) || /\b(want me to|should I|shall I|would you like|do you want)\b/i.test(last);
}

// Memory the session can change, saved before it starts so an interrupted attempt leaves no trace.
async function saveMemory(adapter, paths, id, head) {
  const saved = path.join(paths.root, ".pre", id);
  await fs.rm(saved, { recursive: true, force: true });
  await fs.mkdir(saved, { recursive: true });

  for (const [index, dir] of adapter.memoryDirs(paths).entries()) {
    if (fsSync.existsSync(dir)) {
      await fs.cp(dir, path.join(saved, String(index)), { recursive: true });
    } else {
      await fs.writeFile(path.join(saved, `absent-${index}`), "");
    }
  }

  // Written last: its presence means the save is complete and marks the session as started.
  await fs.writeFile(path.join(saved, "head"), head);
}

async function restoreMemory(adapter, paths, id) {
  const saved = path.join(paths.root, ".pre", id);

  if (!fsSync.existsSync(saved)) {
    return;
  }

  for (const [index, dir] of adapter.memoryDirs(paths).entries()) {
    await fs.rm(dir, { recursive: true, force: true });

    if (!fsSync.existsSync(path.join(saved, `absent-${index}`))) {
      await fs.cp(path.join(saved, String(index)), dir, { recursive: true });
    }
  }
}

async function runTimeline({ dataset, system, adapter = ADAPTERS[resolveArm(system)], paths, outDir, budgetUsd, limit = Infinity, spawn = spawnClaude, snapshot = null }) {
  const systemDir = path.join(outDir, system);
  const records = [];

  await fs.mkdir(systemDir, { recursive: true });

  for (const id of dataset.timeline.slice(0, limit)) {
    const recordPath = path.join(systemDir, `${id}.json`);
    const session = dataset.sessions.get(id);
    const fingerprint = sessionFingerprint(session);

    // A run can be extended with new sessions, but a recorded one must still be the session that ran.
    if (fsSync.existsSync(recordPath)) {
      const recorded = JSON.parse(await fs.readFile(recordPath, "utf8"));

      if (recorded.fingerprint !== fingerprint) {
        throw new Error(`${system} ${id} changed since it ran (prompts or checks); start a new --run`);
      }

      records.push(recorded);
      continue;
    }

    const repo = paths.repos[session.project];
    const transcriptPath = path.join(systemDir, `${id}.jsonl`);
    const record = { id, project: session.project, ok: true, costUsd: 0, sessionUuid: crypto.randomUUID(), fingerprint, turns: 0, offerReplied: false, before: null, after: null };
    Object.assign(record, { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, memoryCalls: 0, memoryBytesIn: 0, autoLoadedBytes: 0 });

    const savedHead = path.join(paths.root, ".pre", id, "head");

    // A started session without a record was interrupted, even inside its first turn: put the repo back
    // to the saved commit (dropping the agent's own commits too) and restore the memory.
    if (fsSync.existsSync(savedHead)) {
      record.retried = true;
      await restoreMemory(adapter, paths, id);
      await git(["checkout", "-q", "-f", "main"], repo);
      await git(["reset", "-q", "--hard", (await fs.readFile(savedHead, "utf8")).trim()], repo);
      await git(["clean", "-fdq"], repo);
    } else {
      // The user comes back to main; work a session left on another branch stays there.
      await git(["checkout", "-q", "main"], repo);
      await saveMemory(adapter, paths, id, await head(repo));
    }

    record.before = await head(repo);

    await fs.rm(transcriptPath, { force: true });

    if (session.kind === "probe" && snapshot) {
      await fs.writeFile(path.join(systemDir, `${id}.snapshot.md`), await snapshot(session));
    }

    // Memory already in context when the session starts, before any tool call.
    for (const entry of await adapter.autoLoaded(paths, session.project)) {
      record.autoLoadedBytes += Buffer.byteLength(entry.text);
    }

    const prompts = [...session.turns];
    let finalText = "";

    for (let index = 0; index < prompts.length; index += 1) {
      const args = adapter.args({ paths, sessionUuid: record.sessionUuid, resume: index > 0, prompt: prompts[index], budgetUsd });
      const result = await spawn("claude", args, { cwd: repo, env: adapter.env(paths) });
      const parsed = parseStream(result.stdout);
      record.turns += 1;
      record.durationMs += parsed.durationMs;

      for (const key of Object.keys(record.tokens)) {
        record.tokens[key] += parsed.tokens[key];
      }

      for (const call of parsed.toolCalls.filter((entry) => adapter.isMemoryCall(entry, paths))) {
        record.memoryCalls += 1;
        record.memoryBytesIn += call.resultBytes || 0;
      }

      await fs.appendFile(transcriptPath, result.stdout.endsWith("\n") || !result.stdout ? result.stdout : `${result.stdout}\n`);
      record.costUsd += parsed.costUsd;

      // A usage or rate limit says nothing about the system: stop without a record so a rerun redoes this session.
      if (parsed.limited) {
        throw new Error(`${system} ${id}: hit the usage limit; rerun the same command after it resets`);
      }

      if (result.code !== 0 || !parsed.ok) {
        record.ok = false;
        break;
      }

      finalText = parsed.finalText;

      // Fixed simulated-user rule, the same for every arm: answer one offer or question with a yes.
      if (index === session.turns.length - 1 && isOffer(finalText)) {
        prompts.push("yes, go ahead");
        record.offerReplied = true;
      }
    }

    await git(["add", "-A"], repo);
    await git(["commit", "-q", "--allow-empty", "-m", commitMessage(id, finalText)], repo);
    record.after = await head(repo);
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    records.push(record);
  }

  return records;
}

function cap(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n[... truncated ${text.length - limit + 40} chars]`;
}

// Which memory the session actually looked at. Native MEMORY.md and the repo CLAUDE.md are
// loaded automatically, so they show up in the snapshot instead.
function recallSignals(toolCalls, paths) {
  const signals = [];
  const nativeDir = path.join(paths.configDir, "projects");
  const add = (signal) => signals.includes(signal) || signals.push(signal);

  for (const { name, input = {} } of toolCalls) {
    if (name.startsWith("mcp__hippocamp__")) {
      add(`hippocamp:${name.slice("mcp__hippocamp__".length)}`);
      continue;
    }

    const target = String(input.file_path || input.path || input.command || "");

    if (target.includes(nativeDir) || target.includes("~/.claude/projects")) {
      add("native:read");
      continue;
    }

    if (name === "Read" && target.endsWith(".md")) {
      for (const repo of Object.values(paths.repos)) {
        const relative = path.relative(repo, target);

        if (!relative.startsWith("..") && !["README.md", "CLAUDE.md"].includes(relative) && !relative.startsWith("node_modules")) {
          add(`repo-note:${relative}`);
        }
      }
    }
  }

  return signals;
}

async function readMarkdownTree(dir, filter = () => true) {
  const files = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    const file = path.join(entry.parentPath || entry.path, entry.name);

    if (entry.isFile() && entry.name.endsWith(".md") && filter(file)) {
      files.push(file);
    }
  }

  return files.sort();
}

// Every memory scope the arm has, not only this project's: a fact stored in the wrong scope must be visible to the judge.
async function memorySnapshot(system, paths, project) {
  const repo = paths.repos[project];
  const notes = await readMarkdownTree(repo, (file) => !file.includes(`${path.sep}node_modules${path.sep}`) && path.basename(file) !== "README.md");
  const entries = [...(await Promise.all(notes.map(async (file) => ({ file, text: await fs.readFile(file, "utf8"), autoLoaded: AUTO_LOADED.has(path.basename(file)) })))), ...(await ADAPTERS[resolveArm(system)].exportMemory(paths, project))];
  const parts = entries.map((entry) => `=== ${entry.file} (${entry.autoLoaded ? "auto-loaded" : "needs a read"}) ===\n${entry.text}`);

  return cap(parts.join("\n"), 30000);
}

async function probeDiff(repo, before, after) {
  const { stdout } = await git(["diff", before, after, "--", ".", ":!node_modules", ":!*.csv", ":!package-lock.json"], repo);
  return cap(stdout, 60000);
}

function printHelp() {
  console.log(`Hippocamp work continuity eval

Runs real headless Claude Code (${MODEL}) through the timeline in bench/continuity: synthetic
projects, one fresh claude process per session, the repo committed after each with the agent's own
summary as the message. If a session ends with an offer or question, the user answers once with
"yes, go ahead". Probe sessions are ordinary tickets with hidden checklists. A blind judge grades
each item; a second call explains each miss; a third grades what each memory stored.

Arms (each installed the way a developer has it):
  cc-none        no memory; auto-memory off
  cc-native      Claude Code defaults: auto-memory on
  cc-hippocamp   Hippocamp through its real installer; auto-memory off
  (old names none, native and hippocamp still work)

Sandboxes live in $HIPPOCAMP_BENCH_DIR (default ~/.cache/hippocamp-bench), each with its own HOME
and CLAUDE_CONFIG_DIR. Results go to .context/continuity/<run>/. Reruns with the same --run skip
finished sessions; a run is frozen by manifest.json (dataset, harness, model, CLI version).

Usage:
  npm run eval:continuity -- [options]

Options:
  --systems LIST   Comma-separated arms. Default: ${SYSTEMS.join(",")}
  --run ID         Run id, also the results folder. Default: today's date
  --limit N        Run only the first N timeline sessions
  --budget USD     --max-budget-usd per claude call. Default: 3
  --judge MODEL    Judge model. Default: ${MODEL}
  --dry-run        Validate the dataset and print the run size and cost range; spawns nothing
  --report RUNS    Rebuild the report for comma-separated finished runs, pooled; spawns nothing
  --force-manifest Resume a run whose manifest changed, recording the change (development only)
  --help           Show this help

Environment:
  CLAUDE_CODE_OAUTH_TOKEN   Claude subscription token from \`claude setup-token\`; preferred
  ANTHROPIC_API_KEY         used only when no subscription token is set
  HIPPOCAMP_BENCH_DIR       where sandboxes live; default ~/.cache/hippocamp-bench
  OPENAI_API_KEY            only for a GPT judge
`);
}

function parseArgs(argv) {
  const options = {
    systems: [...SYSTEMS],
    run: new Date().toISOString().slice(0, 10),
    limit: Infinity,
    budget: 3,
    judge: MODEL,
    dryRun: false,
    forceManifest: false,
    report: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) {
        throw new Error(`${arg} needs a value.`);
      }

      index += 1;
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--report") {
      options.report = next().split(",").filter(Boolean);
    } else if (arg === "--force-manifest") {
      options.forceManifest = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--systems") {
      options.systems = next().split(",").filter(Boolean);
    } else if (arg === "--run") {
      options.run = next();
    } else if (arg === "--limit") {
      options.limit = Number(next());
    } else if (arg === "--budget") {
      options.budget = Number(next());
    } else if (arg === "--judge") {
      options.judge = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.systems = options.systems.map(resolveArm);

  if (!(options.limit >= 1) || !(options.budget > 0)) {
    throw new Error("--limit must be a positive integer and --budget a positive number.");
  }

  if (!/^[\w.-]+$/.test(options.run)) {
    throw new Error("--run may only contain letters, digits, dots, dashes and underscores.");
  }

  return options;
}

// Everything that changes what a run measures. Docs and tests are left out on purpose.
const HARNESS_FILES = [
  "scripts/eval-continuity.cjs",
  "scripts/continuity-adapters.cjs",
  "scripts/continuity-judge.cjs",
  "scripts/continuity-dataset.cjs",
  "scripts/install-claude.cjs",
  "scripts/install-common.cjs",
  "scripts/hippocamp-mcp.cjs",
  "scripts/hippocamp-memory.cjs",
  "skills/hippocamp-memory/SKILL.md",
];

// Paths are hashed relative to the repo, so a run resumes the same from any checkout.
async function hashFiles(files, root) {
  const hash = crypto.createHash("sha256");

  for (const file of [...files].sort()) {
    hash.update(path.relative(root, file)).update("\0").update(await fs.readFile(file).catch(() => "")).update("\0");
  }

  return hash.digest("hex").slice(0, 16);
}

async function runManifest({ repoRoot = REPO_ROOT, datasetDir = DATASET_DIR, judgeModel, budgetUsd, versions }) {
  const datasetFiles = (await fs.readdir(datasetDir, { recursive: true, withFileTypes: true }))
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name))
    .filter((file) => fsSync.statSync(file).isFile() && !path.relative(datasetDir, file).split(path.sep).some((part) => part.startsWith(".") || part === "node_modules"));

  return {
    datasetHash: await hashFiles(datasetFiles, repoRoot),
    harnessHash: await hashFiles(HARNESS_FILES.map((file) => path.join(repoRoot, file)), repoRoot),
    model: MODEL,
    judgeModel,
    budgetUsd,
    versions,
  };
}

// A run is frozen at its first start; resuming or extending it with anything different is refused.
async function checkManifest(outDir, runId, manifest, { force = false } = {}) {
  const file = path.join(outDir, "manifest.json");

  if (!fsSync.existsSync(file)) {
    const dirs = (await fs.readdir(outDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const started = dirs.some((entry) => fsSync.readdirSync(path.join(outDir, entry.name)).some((name) => /^[A-Z]\d+\.json$/.test(name)));

    if (started) {
      throw new Error(`run ${runId} has sessions but no manifest (made by an older harness); start a new --run`);
    }

    await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  const changed = Object.keys(manifest).filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(manifest[key]));

  if (!changed.length) {
    return;
  }

  if (!force) {
    throw new Error(`run ${runId} was started with a different ${changed.join(", ")}; start a new --run`);
  }

  saved.changes = [...(saved.changes || []), { at: new Date().toISOString(), keys: changed, now: Object.fromEntries(changed.map((key) => [key, manifest[key]])) }];
  await fs.writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
}

// The facts as they stand at the end of a (possibly partial) timeline: a replacement planted later does not count yet.
function factsAsOf(facts, timeline) {
  const planted = facts.filter((fact) => timeline.includes(fact.plantedIn));
  const ids = new Set(planted.map((fact) => fact.id));
  return planted.map((fact) => ({ ...fact, supersededBy: ids.has(fact.supersededBy) ? fact.supersededBy : null }));
}

// Judged again when the run was extended past the session it was last judged at.
async function needsQualityJudge(file, through) {
  const saved = await fs.readFile(file, "utf8").then(JSON.parse, () => null);
  return !saved || saved.through !== through;
}

// Human grades typed into the sheet must survive later reports.
async function writeValidationSheet(file, rows, dataset) {
  if (!fsSync.existsSync(file)) {
    await fs.writeFile(file, validationSheet(rows, dataset));
  }
}

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Claude judges run through Claude Code too, so they use the same auth as the sessions (subscription or API key).
async function completeViaClaude(model, { system, messages }, { spawn = spawnClaude, paths }) {
  const args = ["-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config"];

  if (system) {
    args.push("--system-prompt", system);
  }

  await fs.mkdir(paths.configDir, { recursive: true });
  const result = await spawn("claude", args, { cwd: paths.root, env: claudeEnv("none", paths), input: messages.map((message) => message.content).join("\n\n") });
  const parsed = parseStream(result.stdout);

  if (result.code !== 0 || !parsed.ok) {
    throw new Error(`Judge call failed (exit ${result.code}): ${String(result.stderr || result.stdout).slice(0, 300)}`);
  }

  return { text: parsed.finalText, costUsd: parsed.costUsd, usage: {} };
}

async function judgeSystem({ dataset, system, paths, outDir, records, judge, judgedPath, done, complete }) {
  const factsById = new Map(dataset.facts.map((fact) => [fact.id, fact]));
  const rows = [];

  for (const record of records) {
    const session = dataset.sessions.get(record.id);

    if (session.kind !== "probe" || done.has(`${system}:${record.id}`)) {
      continue;
    }

    const systemDir = path.join(outDir, system);
    const stream = parseStream(await fs.readFile(path.join(systemDir, `${record.id}.jsonl`), "utf8").catch(() => ""));
    const diff = await probeDiff(paths.repos[session.project], record.before, record.after);
    const exchange = {};
    // Keep exactly what the judge saw and said, so every verdict can be audited and published.
    const recording = async (model, request) => {
      exchange.prompt = request.messages.map((message) => message.content).join("\n\n");
      const response = await complete(model, request);
      exchange.reply = response.text;
      return response;
    };
    const adapter = ADAPTERS[resolveArm(system)];
    const items = await judgeProbe({
      session,
      facts: dataset.facts,
      diff: blindText(diff, { paths }),
      digest: blindDigest(stream.toolCalls, stream.finalText, { adapter, paths }),
      judgeModel: judge,
      complete: recording,
    });
    const misses = items.filter((item) => item.pass === false && !item.cause).map((item) => item.item);

    // Attribution sees the memory and the real tool names; it runs only after the blind verdicts are fixed.
    if (misses.length) {
      const attribution = {};
      const causes = await attributeMisses({
        session,
        facts: dataset.facts,
        misses,
        snapshot: await fs.readFile(path.join(systemDir, `${record.id}.snapshot.md`), "utf8").catch(() => ""),
        digest: transcriptDigest(stream.toolCalls, stream.finalText),
        judgeModel: judge,
        complete: async (model, request) => {
          attribution.prompt = request.messages[0].content;
          const response = await complete(model, request);
          attribution.reply = response.text;
          return response;
        },
      });
      exchange.attribution = attribution;

      for (const { item, cause, source } of causes) {
        Object.assign(items.find((entry) => entry.item === item), { cause, source });
      }
    }

    await fs.writeFile(path.join(systemDir, `${record.id}.diff`), diff);
    await fs.writeFile(path.join(systemDir, `${record.id}.judge.json`), `${JSON.stringify(exchange, null, 2)}\n`);

    for (const item of items) {
      const checklistItem = session.checklist.find((entry) => entry.id === item.item);
      const fact = factsById.get(checklistItem.fact);
      rows.push({ system, probe: record.id, cause: null, source: null, ...item, fact: fact.id, kind: fact.kind, distance: factDistance(dataset.timeline, fact, record.id), leak: Boolean(checklistItem.leak), memory: Boolean(checklistItem.memory) });
    }

    await fs.appendFile(judgedPath, rows.filter((row) => row.probe === record.id).map((row) => `${JSON.stringify(row)}\n`).join(""));
  }

  return rows;
}

async function run(options) {
  const dataset = await loadDataset(DATASET_DIR);
  const errors = validateDataset(dataset);

  if (errors.length) {
    throw new Error(`Dataset is invalid:\n${errors.join("\n")}`);
  }

  const timeline = dataset.timeline.slice(0, options.limit);
  const turns = timeline.reduce((sum, id) => sum + dataset.sessions.get(id).turns.length, 0);
  const probes = timeline.filter((id) => dataset.sessions.get(id).kind === "probe").length;
  const runs = timeline.length * options.systems.length;

  console.log(`${timeline.length} sessions (${probes} probes, ${turns} turns) x ${options.systems.length} systems (${options.systems.join(", ")})`);
  console.log(`Estimated agent cost: $${(runs * SESSION_COST_RANGE[0]).toFixed(0)}-$${(runs * SESSION_COST_RANGE[1]).toFixed(0)}, plus ${probes * options.systems.length} judge calls`);

  if (options.dryRun) {
    return;
  }

  const outDir = path.join(RESULTS_DIR, options.run);
  const judgedPath = path.join(outDir, "judged.jsonl");
  await fs.mkdir(outDir, { recursive: true });
  const claudeVersion = (await execFileAsync("claude", ["--version"])).stdout.trim();
  await checkManifest(outDir, options.run, await runManifest({ judgeModel: options.judge, budgetUsd: options.budget, versions: { claude: claudeVersion } }), { force: options.forceManifest });

  // Systems run side by side; sessions within a system stay strictly in timeline order.
  // allSettled: one system failing must not exit while the others have claude mid-turn.
  const settled = await Promise.allSettled(
    options.systems.map(async (system) => {
      const paths = sandboxPaths(options.run, system);
      assertNoInstructionFiles(path.dirname(paths.root));
      await assertSandboxIntact(paths, path.join(outDir, system));
      await prepareSandbox(dataset, paths, system);
      const records = await runTimeline({
        dataset: { ...dataset, timeline },
        system,
        paths,
        outDir,
        budgetUsd: options.budget,
        snapshot: (session) => memorySnapshot(system, paths, session.project),
      });
      console.log(`${system}: ${records.length} sessions, $${records.reduce((sum, record) => sum + record.costUsd, 0).toFixed(2)}`);
      return { system, paths, records };
    }),
  );

  const failures = settled.filter((result) => result.status === "rejected");

  if (failures.length) {
    throw new Error(failures.map((result) => result.reason.message).join("\n"));
  }

  const perSystem = settled.map((result) => result.value);
  const judgePaths = sandboxPaths(options.run, "judge");
  const complete = options.judge.startsWith("claude-") ? (model, request) => completeViaClaude(model, request, { paths: judgePaths }) : completeModel;
  const done = new Set((await readJsonl(judgedPath)).map((row) => `${row.system}:${row.probe}`));

  for (const { system, paths, records } of perSystem) {
    await judgeSystem({ dataset, system, paths, outDir, records, judge: options.judge, judgedPath, done, complete });
  }

  // What each memory holds at the end of the run, judged blind against the facts planted so far.
  const planted = factsAsOf(dataset.facts, timeline);

  for (const { system, paths } of perSystem) {
    const qualityPath = path.join(outDir, system, "memory-quality.json");
    const through = timeline[timeline.length - 1];

    if (!(await needsQualityJudge(qualityPath, through))) {
      continue;
    }

    const entries = await ADAPTERS[resolveArm(system)].exportMemory(paths, Object.keys(paths.repos)[0]);
    const finalDir = path.join(outDir, system, "memory-final");
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.mkdir(finalDir, { recursive: true });

    for (const [index, entry] of entries.entries()) {
      await fs.writeFile(path.join(finalDir, `m${index + 1}.md`), `<!-- ${path.relative(paths.root, entry.file)} -->\n${entry.text}`);
    }

    const result = entries.length ? await judgeMemory({ facts: planted, entries, judgeModel: options.judge, complete }) : { labels: [], quality: null };
    await fs.writeFile(qualityPath, `${JSON.stringify({ through, ...result }, null, 2)}\n`);
  }

  const report = await buildReport([options.run], dataset);
  await fs.writeFile(path.join(outDir, "report.md"), report);
  console.log(`\n${report}`);
  console.log(`Results: ${outDir}`);
}

// Judged rows, session records and memory quality of one finished (or partial) run, tagged with its id.
async function loadRun(runId) {
  const outDir = path.join(RESULTS_DIR, runId);
  // Runs from before the adapters used the names none, native and hippocamp.
  const arm = (name) => {
    try {
      return resolveArm(name);
    } catch {
      return name;
    }
  };
  const rows = (await readJsonl(path.join(outDir, "judged.jsonl"))).map((row) => ({ ...row, system: arm(row.system), run: runId }));
  const records = [];
  const qualities = {};

  for (const entry of await fs.readdir(outDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(outDir, entry.name);

    for (const file of (await fs.readdir(dir)).filter((name) => /^[A-Z]\d+\.json$/.test(name))) {
      records.push({ ...JSON.parse(await fs.readFile(path.join(dir, file), "utf8")), system: arm(entry.name), run: runId });
    }

    const quality = path.join(dir, "memory-quality.json");
    if (fsSync.existsSync(quality)) {
      qualities[arm(entry.name)] = JSON.parse(await fs.readFile(quality, "utf8")).quality;
    }
  }

  return { rows, records, qualities };
}

async function buildReport(runIds, dataset) {
  const loaded = await Promise.all(runIds.map(loadRun));
  const rows = loaded.flatMap((run) => run.rows);
  const records = loaded.flatMap((run) => run.records);
  const qualities = {};

  for (const run of loaded) {
    for (const [system, quality] of Object.entries(run.qualities)) {
      qualities[system] = [...(qualities[system] || []), quality];
    }
  }

  const pairs = [["cc-hippocamp", "cc-native"], ...ARMS.filter((arm) => arm !== "cc-none").map((arm) => [arm, "cc-none"])];
  const intervals = pairs
    .filter(([a, b]) => rows.some((row) => row.system === a) && rows.some((row) => row.system === b))
    .map(([a, b]) => {
      const { diff, low, high } = bootstrapDiff(rows.filter((row) => row.system === a), rows.filter((row) => row.system === b));
      return `- ${a} vs ${b}: ${diff >= 0 ? "+" : ""}${Math.round(diff * 100)} points (95% CI ${Math.round(low * 100)} to ${Math.round(high * 100)})`;
    });

  const sheet = runIds.length === 1 ? path.join(RESULTS_DIR, runIds[0], "validation.csv") : path.join(RESULTS_DIR, `validation-${runIds.join("+")}.csv`);
  await writeValidationSheet(sheet, rows, dataset);

  return [
    `# Work continuity: ${runIds.join(", ")}`,
    "## Outcome",
    summarize(rows, records),
    "## By kind and distance",
    breakdownTable(rows),
    "## Efficiency",
    efficiencyTable(records, rows),
    "## Memory quality",
    Object.keys(qualities).length ? qualityTable(qualities) : "(not measured in these runs)",
    "## Differences (bootstrap over probes)",
    intervals.length ? intervals.join("\n") : "(needs two arms)",
  ].join("\n\n") + "\n";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.report) {
    const report = await buildReport(options.report, await loadDataset(DATASET_DIR));
    const file = path.join(RESULTS_DIR, `report-${options.report.join("+")}.md`);
    await fs.writeFile(file, report);
    console.log(`${report}\nReport: ${file}`);
    return;
  }

  await run(options);
}

module.exports = {
  assertNoInstructionFiles,
  assertSandboxIntact,
  benchRoot,
  SYSTEMS,
  checkManifest,
  claudeArgs,
  claudeEnv,
  commitMessage,
  completeViaClaude,
  factsAsOf,
  isOffer,
  judgeProbe,
  memorySnapshot,
  needsQualityJudge,
  parseArgs,
  parseStream,
  prepareSandbox,
  probeDiff,
  recallSignals,
  runManifest,
  runTimeline,
  sessionFingerprint,
  sandboxPaths,
  summarize,
  transcriptDigest,
  validationSheet,
  writeValidationSheet,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
