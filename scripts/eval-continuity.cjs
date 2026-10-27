#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn: spawnChild } = require("node:child_process");
const { promisify } = require("node:util");
const { prepareLagoon } = require("./install-common.cjs");
const { factDistance, loadDataset, validateDataset } = require("./continuity-dataset.cjs");
const { complete: completeModel } = require("./eval-locomo.cjs");
const { ensureClaudeInstructionsInstalled, ensureClaudeSkillInstalled } = require("./install-claude.cjs");

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const MODEL = "claude-opus-5-5";
const DATASET_DIR = path.join(REPO_ROOT, "bench", "continuity");
const RESULTS_DIR = path.join(REPO_ROOT, ".context", "continuity");
// Rough $ per Opus session, before the smoke run measures it.
const SESSION_COST_RANGE = [0.3, 1.5];
const SYSTEMS = ["none", "native", "hippocamp"];
// Native auto-memory lands in <CLAUDE_CONFIG_DIR>/projects/<cwd slug>/memory/*.md (checked live
// with claude 2.1.311): MEMORY.md is the index Claude Code loads, the other files hold one memory each.
const NATIVE_MEMORY_GLOB = ["projects", "*", "memory"];
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
};

// Sandboxes live under the OS temp dir: Claude Code loads CLAUDE.md from parent folders,
// so a sandbox inside this repo would see Hippocamp's own guidance.
function sandboxPaths(runId, system) {
  // Resolved, because Claude Code reports its cwd and file paths through symlinks such as macOS /var -> /private/var.
  const root = path.join(fsSync.realpathSync(os.tmpdir()), "hippocamp-continuity", runId, system);
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

async function prepareSandbox(dataset, paths, system, { install = true } = {}) {
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

  if (system === "hippocamp") {
    await prepareLagoon(paths.lagoon);
    await ensureClaudeInstructionsInstalled({ claudeHome: paths.configDir });
    await ensureClaudeSkillInstalled({ claudeHome: paths.configDir, repoRoot: REPO_ROOT });

    for (const [key, value] of [["user.name", GIT_IDENTITY.GIT_AUTHOR_NAME], ["user.email", GIT_IDENTITY.GIT_AUTHOR_EMAIL]]) {
      await git(["config", key, value], paths.lagoon);
    }

    const server = {
      command: process.execPath,
      args: [path.join(REPO_ROOT, "scripts", "hippocamp-mcp.cjs")],
      env: { HIPPOCAMP_GLOBAL_ROOT: paths.lagoon, ...GIT_IDENTITY },
    };
    await fs.writeFile(paths.mcpConfig, `${JSON.stringify({ mcpServers: { hippocamp: server } }, null, 2)}\n`);
  }

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
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !/^(HIPPOCAMP_|CLAUDE_)/.test(key)));

  Object.assign(env, GIT_IDENTITY, { HOME: paths.home, CLAUDE_CONFIG_DIR: paths.configDir });

  if (system !== "native") {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }

  if (system === "hippocamp") {
    env.HIPPOCAMP_GLOBAL_ROOT = paths.lagoon;
  }

  return env;
}

function claudeArgs({ system, paths, sessionUuid, resume, prompt, budgetUsd }) {
  const args = [
    "-p",
    prompt,
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--max-budget-usd",
    String(budgetUsd),
    resume ? "--resume" : "--session-id",
    sessionUuid,
  ];

  if (system === "hippocamp") {
    args.push("--mcp-config", paths.mcpConfig);
  }

  return args;
}

// Reads Claude Code's stream-json output. A missing result, an error flag or any subtype
// other than success (budget cap, max turns) marks the turn as failed.
function parseStream(text) {
  const parsed = { costUsd: 0, ok: false, toolCalls: [], finalText: "" };

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
        }
      }
    }

    if (event.type === "result") {
      parsed.costUsd += event.total_cost_usd || 0;
      parsed.ok = event.is_error === false && event.subtype === "success";
      parsed.finalText = typeof event.result === "string" ? event.result : "";
    }
  }

  return parsed;
}

function spawnClaude(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
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
async function runTimeline({ dataset, system, paths, outDir, budgetUsd, limit = Infinity, spawn = spawnClaude, snapshot = null }) {
  const systemDir = path.join(outDir, system);
  const records = [];

  await fs.mkdir(systemDir, { recursive: true });

  for (const id of dataset.timeline.slice(0, limit)) {
    const recordPath = path.join(systemDir, `${id}.json`);

    if (fsSync.existsSync(recordPath)) {
      records.push(JSON.parse(await fs.readFile(recordPath, "utf8")));
      continue;
    }

    const session = dataset.sessions.get(id);
    const repo = paths.repos[session.project];
    const transcriptPath = path.join(systemDir, `${id}.jsonl`);
    const record = { id, project: session.project, ok: true, costUsd: 0, sessionUuid: crypto.randomUUID(), before: await head(repo), after: null };

    // A transcript without a record means an interrupted attempt: drop its uncommitted work.
    if (fsSync.existsSync(transcriptPath)) {
      record.retried = true;
      await git(["reset", "-q", "--hard"], repo);
      await git(["clean", "-fdq"], repo);
    }

    await fs.rm(transcriptPath, { force: true });

    if (session.kind === "probe" && snapshot) {
      await fs.writeFile(path.join(systemDir, `${id}.snapshot.md`), await snapshot(session));
    }

    for (const [index, prompt] of session.turns.entries()) {
      const args = claudeArgs({ system, paths, sessionUuid: record.sessionUuid, resume: index > 0, prompt, budgetUsd });
      const result = await spawn("claude", args, { cwd: repo, env: claudeEnv(system, paths) });
      const parsed = parseStream(result.stdout);

      await fs.appendFile(transcriptPath, result.stdout.endsWith("\n") || !result.stdout ? result.stdout : `${result.stdout}\n`);
      record.costUsd += parsed.costUsd;

      if (result.code !== 0 || !parsed.ok) {
        record.ok = false;
        break;
      }
    }

    await git(["add", "-A"], repo);
    await git(["commit", "-q", "--allow-empty", "-m", id], repo);
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

// Files the agent sees without asking: the repo and native CLAUDE.md/MEMORY.md, and what Hippocamp wake_up returns.
const AUTO_LOADED = new Set(["CLAUDE.md", "MEMORY.md", "current_state.md", "open_threads.md", "project.md", "identity.md", "preferences.md"]);

// Everything the agent could have kept between sessions, for the judge's miss attribution.
async function memorySnapshot(system, paths, project) {
  const repo = paths.repos[project];
  const files = await readMarkdownTree(repo, (file) => !file.includes(`${path.sep}node_modules${path.sep}`) && path.basename(file) !== "README.md");

  if (system === "native") {
    const projectsDir = path.join(paths.configDir, ...NATIVE_MEMORY_GLOB.slice(0, 1));
    files.push(...(await readMarkdownTree(projectsDir, (file) => file.includes(`repos-${project}${path.sep}memory${path.sep}`))));
  }

  if (system === "hippocamp") {
    files.push(
      ...(await readMarkdownTree(paths.lagoon, (file) => {
        const relative = path.relative(paths.lagoon, file);
        return !relative.startsWith("projects") || relative.startsWith(path.join("projects", project));
      })),
    );
  }

  const parts = [];

  for (const file of files) {
    parts.push(`=== ${file} (${AUTO_LOADED.has(path.basename(file)) ? "auto-loaded" : "needs a read"}) ===\n${await fs.readFile(file, "utf8")}`);
  }

  return cap(parts.join("\n"), 30000);
}

function transcriptDigest(toolCalls, finalText) {
  const final = `\nFINAL ANSWER:\n${cap(finalText, 8000)}`;
  // Memory tools and Markdown reads keep a slice of their result, so the judge can tell not-recalled from ignored.
  const lines = toolCalls.map(({ name, input, result }) => {
    const line = `${name}: ${JSON.stringify(input ?? {}).slice(0, 200)}`;
    const shown = result && (name.startsWith("mcp__") || String(input?.file_path || "").endsWith(".md"));
    return shown ? `${line}\n  -> ${result.slice(0, 1500).replace(/\n/g, "\n     ")}` : line;
  });

  return `${cap(lines.join("\n"), 40000 - final.length)}${final}`;
}

async function probeDiff(repo, before, after) {
  const { stdout } = await git(["diff", before, after, "--", ".", ":!node_modules", ":!*.csv", ":!package-lock.json"], repo);
  return cap(stdout, 60000);
}

const JUDGE_PROMPT = `You grade one session of a coding agent that works on a project across many independent sessions.
Earlier sessions established facts the agent was never reminded of in this session. Decide, for each checklist item,
whether the agent's work in this session respects the fact.

# Session request
{request}

# Checklist (item id, check, underlying fact)
{checklist}

# Diff of this session
{diff}

# Tool calls and final answer of this session
{digest}

# Memory available when the session started (repo notes, native memory or Hippocamp)
{snapshot}

# Memory the session explicitly read
{signals}

For each item return:
- "pass": true when the work respects the fact; false when it contradicts it; "n/a" when the session never touched that area, so the item says nothing either way.
- "source": where the agent got the fact: "code" (visible in the repo code), "repo-note", "native", "hippocamp", "prompt", or "none".
- "cause": null when pass is true; otherwise "never-stored" (the fact is not in any memory above), "not-recalled" (it is stored but the session never saw it), or "ignored" (the session saw it and acted against it).

Reply with JSON only: {"items":[{"id":"...","pass":true,"source":"...","cause":null}]}`;

function parseJudgeReply(text) {
  const match = String(text).match(/\{[\s\S]*\}/);

  try {
    return match ? JSON.parse(match[0]).items || [] : [];
  } catch {
    return [];
  }
}

async function judgeProbe({ session, facts, diff, digest, snapshot, signals, judgeModel, complete = completeModel }) {
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const checklist = session.checklist
    .map((item) => {
      const statement = factsById.get(item.fact)?.statement || item.fact;
      return `- ${item.id}: ${item.check} (${item.leak ? `must NOT carry over from another project: ${statement}` : `fact: ${statement}`})`;
    })
    .join("\n");
  const prompt = JUDGE_PROMPT.replace("{request}", () => session.turns.join("\n\n"))
    .replace("{checklist}", () => checklist)
    .replace("{diff}", () => diff || "(no changes)")
    .replace("{digest}", () => digest || "(none)")
    .replace("{snapshot}", () => snapshot || "(empty)")
    .replace("{signals}", () => (signals.length ? signals.join(", ") : "(none)"));
  const response = await complete(judgeModel, { messages: [{ role: "user", content: prompt }], json: true });
  const replies = new Map(parseJudgeReply(response.text).map((item) => [item.id, item]));

  return session.checklist.map((item) => {
    const reply = replies.get(item.id);

    if (reply?.pass === "n/a") {
      return { item: item.id, pass: null, source: reply.source || "none", cause: null };
    }

    if (!reply || typeof reply.pass !== "boolean") {
      return { item: item.id, pass: false, source: "none", cause: "judge-missing" };
    }

    return { item: item.id, pass: reply.pass, source: reply.source || "none", cause: reply.pass ? null : reply.cause || "unknown" };
  });
}

const KINDS = ["state", "decision", "constraint", "asset", "done", "preference"];
const BANDS = [
  ["1-2", (distance) => distance <= 2],
  ["3-5", (distance) => distance >= 3 && distance <= 5],
  ["6+", (distance) => distance >= 6],
];
const CAUSES = ["never-stored", "not-recalled", "ignored"];

// N/A items (pass === null) count in neither direction.
function passRate(rows) {
  const graded = rows.filter((row) => row.pass !== null);
  return graded.length ? `${Math.round((100 * graded.filter((row) => row.pass).length) / graded.length)}%` : "-";
}

// rows: judged checklist items tagged with system, kind and distance. records: session records tagged with system.
function summarize(rows, records) {
  const header = ["System", "Pass", "Memory-only", ...KINDS, ...BANDS.map(([label]) => label), ...CAUSES, "N/A", "Agent $", "Failed sessions"];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];

  for (const system of SYSTEMS.filter((name) => rows.some((row) => row.system === name))) {
    const mine = rows.filter((row) => row.system === system);
    const sessions = records.filter((record) => record.system === system);
    const cells = [
      system,
      passRate(mine),
      passRate(mine.filter((row) => row.memory)),
      ...KINDS.map((kind) => passRate(mine.filter((row) => row.kind === kind))),
      ...BANDS.map(([, inBand]) => passRate(mine.filter((row) => inBand(row.distance)))),
      ...CAUSES.map((cause) => String(mine.filter((row) => row.cause === cause).length)),
      String(mine.filter((row) => row.pass === null).length),
      `$${sessions.reduce((sum, record) => sum + record.costUsd, 0).toFixed(2)}`,
      String(sessions.filter((record) => !record.ok).length),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

function printHelp() {
  console.log(`Hippocamp work continuity eval

Runs real headless Claude Code (${MODEL}) through the 16-session timeline in bench/continuity:
two synthetic projects, one fresh claude process per session, the repo committed after each.
Probe sessions are ordinary tickets with hidden checklists; a judge model grades each item and
labels misses as never stored, stored but not recalled, or recalled but ignored.

Systems:
  none        no memory; the repo still carries over between sessions
  native      Claude Code auto-memory (CLAUDE.md and the memory folder)
  hippocamp   Hippocamp MCP on a throwaway Lagoon, installer guidance in the user CLAUDE.md

Every run is isolated: sandboxes under the OS temp dir with their own HOME and CLAUDE_CONFIG_DIR.
Results go to .context/continuity/<run>/. Reruns with the same --run skip finished sessions.

Usage:
  npm run eval:continuity -- [options]

Options:
  --systems LIST   Comma-separated systems. Default: ${SYSTEMS.join(",")}
  --run ID         Run id, also the results folder. Default: today's date
  --limit N        Run only the first N timeline sessions
  --budget USD     --max-budget-usd per claude call. Default: 3
  --judge MODEL    Judge model. Default: ${MODEL}
  --dry-run        Validate the dataset and print the run size and cost range; spawns nothing
  --help           Show this help

Environment:
  ANTHROPIC_API_KEY   Claude Code sessions and the default judge
  OPENAI_API_KEY      only for a GPT judge
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

  for (const system of options.systems) {
    if (!SYSTEMS.includes(system)) {
      throw new Error(`Unknown system: ${system}. Use ${SYSTEMS.join(", ")}.`);
    }
  }

  if (!(options.limit >= 1) || !(options.budget > 0)) {
    throw new Error("--limit must be a positive integer and --budget a positive number.");
  }

  if (!/^[\w.-]+$/.test(options.run)) {
    throw new Error("--run may only contain letters, digits, dots, dashes and underscores.");
  }

  return options;
}

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function judgeSystem({ dataset, system, paths, outDir, records, judge, judgedPath, done }) {
  const factsById = new Map(dataset.facts.map((fact) => [fact.id, fact]));
  const rows = [];

  for (const record of records) {
    const session = dataset.sessions.get(record.id);

    if (session.kind !== "probe" || done.has(`${system}:${record.id}`)) {
      continue;
    }

    const systemDir = path.join(outDir, system);
    const stream = parseStream(await fs.readFile(path.join(systemDir, `${record.id}.jsonl`), "utf8").catch(() => ""));
    const signals = recallSignals(stream.toolCalls, paths);
    const items = await judgeProbe({
      session,
      facts: dataset.facts,
      diff: await probeDiff(paths.repos[session.project], record.before, record.after),
      digest: transcriptDigest(stream.toolCalls, stream.finalText),
      snapshot: await fs.readFile(path.join(systemDir, `${record.id}.snapshot.md`), "utf8").catch(() => ""),
      signals,
      judgeModel: judge,
    });

    for (const item of items) {
      const checklistItem = session.checklist.find((entry) => entry.id === item.item);
      const fact = factsById.get(checklistItem.fact);
      rows.push({ system, probe: record.id, ...item, fact: fact.id, kind: fact.kind, distance: factDistance(dataset.timeline, fact, record.id), leak: Boolean(checklistItem.leak), memory: Boolean(checklistItem.memory), signals });
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

  // Systems run side by side; sessions within a system stay strictly in timeline order.
  // allSettled: one system failing must not exit while the others have claude mid-turn.
  const settled = await Promise.allSettled(
    options.systems.map(async (system) => {
      const paths = sandboxPaths(options.run, system);
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
  const done = new Set((await readJsonl(judgedPath)).map((row) => `${row.system}:${row.probe}`));

  for (const { system, paths, records } of perSystem) {
    await judgeSystem({ dataset, system, paths, outDir, records, judge: options.judge, judgedPath, done });
  }

  const rows = (await readJsonl(judgedPath)).filter((row) => options.systems.includes(row.system) && timeline.includes(row.probe));
  const records = perSystem.flatMap(({ system, records }) => records.map((record) => ({ ...record, system })));
  const report = `# Work continuity run ${options.run}\n\n${summarize(rows, records)}\n`;

  await fs.writeFile(path.join(outDir, "report.md"), report);
  console.log(`\n${report}`);
  console.log(`Results: ${outDir}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  await run(options);
}

module.exports = {
  NATIVE_MEMORY_GLOB,
  assertSandboxIntact,
  SYSTEMS,
  claudeArgs,
  claudeEnv,
  judgeProbe,
  memorySnapshot,
  parseArgs,
  parseStream,
  prepareSandbox,
  probeDiff,
  recallSignals,
  runTimeline,
  sandboxPaths,
  summarize,
  transcriptDigest,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
