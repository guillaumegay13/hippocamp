const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadDataset } = require("../scripts/continuity-dataset.cjs");
const { ADAPTERS } = require("../scripts/continuity-adapters.cjs");
const { execFileSync } = require("node:child_process");
const {
  assertNoInstructionFiles,
  assertSandboxIntact,
  checkManifest,
  benchRoot,
  claudeArgs,
  claudeEnv,
  commitMessage,
  completeViaClaude,
  isOffer,
  judgeProbe,
  memorySnapshot,
  needsQualityJudge,
  parseArgs,
  parseStream,
  prepareSandbox,
  recallSignals,
  runManifest,
  runTimeline,
  sandboxPaths,
  transcriptDigest,
  validationSheet,
  writeValidationSheet,
} = require("../scripts/eval-continuity.cjs");

const DATASET_DIR = path.join(__dirname, "..", "bench", "continuity");

// Tests never write sandboxes into the real ~/.cache.
process.env.HIPPOCAMP_BENCH_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "bench-root-"));

test("benchRoot defaults to a neutral folder outside HOME and honors HIPPOCAMP_BENCH_DIR", () => {
  assert.equal(benchRoot({ HOME: "/h" }), "/var/tmp/agent-bench");
  assert.equal(benchRoot({ HOME: "/h", HIPPOCAMP_BENCH_DIR: "/x" }), "/x");
});

test("sandboxPaths stays outside the OS temp dir and this repo", () => {
  const paths = sandboxPaths("r1", "cc-native", { HOME: os.homedir() });

  assert.ok(!paths.root.startsWith(fsSync.realpathSync(os.tmpdir())), paths.root);
  assert.ok(!paths.root.startsWith(path.resolve(__dirname, "..")), paths.root);
  assert.ok(!/cc-|native|hippocamp/.test(path.relative(benchRoot({ HOME: os.homedir() }), paths.root)), paths.root);
  assert.equal(sandboxPaths("r1", "cc-native", { HOME: os.homedir() }).root, paths.root);
  assert.notEqual(sandboxPaths("r1", "cc-hippocamp", { HOME: os.homedir() }).root, paths.root);
  assert.equal(paths.home, path.join(paths.root, "home"));
  assert.equal(paths.configDir, path.join(paths.home, ".claude"));
});

test("claudeEnv isolates home and memory per system", () => {
  const base = { PATH: "/bin", ANTHROPIC_API_KEY: "k", HIPPOCAMP_GLOBAL_ROOT: "/real", CLAUDE_CONFIG_DIR: "/real/.claude", HOME: "/real-home" };
  const none = claudeEnv("none", sandboxPaths("t", "none"), base);
  const native = claudeEnv("native", sandboxPaths("t", "native"), base);
  const hippocamp = claudeEnv("hippocamp", sandboxPaths("t", "hippocamp"), base);

  assert.equal(none.HOME, sandboxPaths("t", "none").home);
  assert.equal(none.CLAUDE_CONFIG_DIR, sandboxPaths("t", "none").configDir);
  assert.equal(none.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(none.HIPPOCAMP_GLOBAL_ROOT, undefined);
  assert.equal(none.ANTHROPIC_API_KEY, "k");
  assert.equal(none.PATH, "/bin");
  assert.equal(native.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
  assert.equal(hippocamp.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  // The MCP server gets HIPPOCAMP_GLOBAL_ROOT from the config the installer wrote, as in a real install.
  assert.equal(hippocamp.HIPPOCAMP_GLOBAL_ROOT, undefined);
});

test("claudeArgs uses resume after the first turn and mcp only for hippocamp", () => {
  const first = claudeArgs({ system: "cc-native", paths: sandboxPaths("t", "native"), sessionUuid: "u1", resume: false, prompt: "hi", budgetUsd: 3 });
  const later = claudeArgs({ system: "cc-hippocamp", paths: sandboxPaths("t", "hippocamp"), sessionUuid: "u1", resume: true, prompt: "more", budgetUsd: 3 });

  assert.deepEqual(first.slice(0, 2), ["-p", "hi"]);
  assert.ok(first.includes("--session-id") && !first.includes("--resume"));
  assert.ok(!first.includes("--mcp-config"));
  assert.equal(first[first.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(first[first.indexOf("--max-budget-usd") + 1], "3");
  assert.ok(first.includes("--strict-mcp-config"));
  assert.ok(later.includes("--resume") && !later.includes("--session-id"));
  assert.equal(later[later.indexOf("--mcp-config") + 1], sandboxPaths("t", "hippocamp").mcpConfig);
});

test("prepareSandbox gives every system the same repo CLAUDE.md", async () => {
  const dataset = await loadDataset(DATASET_DIR);
  const runId = `test-${process.pid}-${Date.now()}`;
  const contents = {};

  try {
    for (const system of ["none", "native", "hippocamp"]) {
      const paths = sandboxPaths(runId, system);
      await prepareSandbox(dataset, paths, system, { install: false });
      contents[system] = await fs.readFile(path.join(paths.repos.relay, "CLAUDE.md"), "utf8");
      assert.ok(fsSync.existsSync(path.join(paths.repos.ingest, ".git")));
    }

    assert.equal(contents.none, contents.native);
    assert.equal(contents.none, contents.hippocamp);

    const hippocamp = sandboxPaths(runId, "hippocamp");
    const userClaude = await fs.readFile(path.join(hippocamp.configDir, "CLAUDE.md"), "utf8");
    const mcp = JSON.parse(await fs.readFile(hippocamp.mcpConfig, "utf8"));

    assert.ok(userClaude.includes("hippocamp:managed:start"));
    assert.equal(mcp.mcpServers.hippocamp.env.HIPPOCAMP_GLOBAL_ROOT, hippocamp.lagoon);
    assert.ok(!fsSync.existsSync(path.join(sandboxPaths(runId, "native").configDir, "CLAUDE.md")));
  } finally {
    await fs.rm(path.dirname(sandboxPaths(runId, "none").root), { recursive: true, force: true, maxRetries: 5 });
  }
});

function streamLines(...events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const toolUse = { type: "assistant", message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "t0", name: "mcp__hippocamp__search_memory", input: { query: "retries" } }] } };
const success = (cost) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: "done" });

test("parseStream sums tokens and duration across turns", () => {
  const usage = (input, output) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, duration_ms: 1000, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }, result: "ok" });
  const parsed = parseStream(streamLines(usage(10, 3), usage(20, 4)));

  assert.deepEqual(parsed.tokens, { input: 30, output: 7, cacheRead: 10, cacheWrite: 4 });
  assert.equal(parsed.durationMs, 2000);
});

test("records count memory calls, memory bytes read and auto-loaded memory", async (t) => {
  const { dataset, paths, outDir } = await runnerFixture(t);
  const adapter = { ...ADAPTERS["cc-hippocamp"], args: ADAPTERS["cc-none"].args, autoLoaded: async () => [{ file: "a", text: "x".repeat(40), autoLoaded: true }] };
  const search = { type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "mcp__hippocamp__search_memory", input: { query: "chunk" } }] } };
  const found = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "z".repeat(25) }] } };
  const spawn = async () => ({ code: 0, stdout: streamLines(search, found, success(0.1)) });
  const records = await runTimeline({ dataset: { ...dataset, timeline: ["S2"] }, system: "none", adapter, paths, outDir, budgetUsd: 3, spawn });

  assert.equal(records[0].memoryCalls, 1);
  assert.equal(records[0].memoryBytesIn, 25);
  assert.equal(records[0].autoLoadedBytes, 40);
});

test("parseStream sums cost and collects tool calls", () => {
  const parsed = parseStream(streamLines({ type: "system", subtype: "init" }, toolUse, success(0.42)));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.costUsd, 0.42);
  assert.equal(parsed.finalText, "done");
  assert.deepEqual(parsed.toolCalls, [{ id: "t0", name: "mcp__hippocamp__search_memory", input: { query: "retries" } }]);
});

test("parseStream marks error results", () => {
  assert.equal(parseStream(streamLines({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 3 })).ok, false);
  assert.equal(parseStream(streamLines({ type: "result", subtype: "success", is_error: true })).ok, false);
  assert.equal(parseStream(streamLines(toolUse)).ok, false);
  assert.equal(parseStream("not json\n").ok, false);
});

// A two-session dataset over a throwaway relay seed, with a fake claude that edits the repo.
async function runnerFixture(t) {
  const runId = `runner-${process.pid}-${Date.now()}`;
  const seedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-seed-"));
  const seeds = { relay: path.join(seedRoot, "relay"), ingest: path.join(seedRoot, "ingest") };

  for (const seed of Object.values(seeds)) {
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, "README.md"), "seed\n");
  }

  const sessions = new Map(
    [
      { id: "S1", project: "relay", kind: "work", turns: ["first", "second"], plants: [], checklist: [] },
      { id: "S2", project: "relay", kind: "work", turns: ["third"], plants: [], checklist: [] },
    ].map((session) => [session.id, session]),
  );
  const dataset = { facts: [], sessions, timeline: ["S1", "S2"], seeds };
  const paths = sandboxPaths(runId, "none");
  const outDir = path.join(seedRoot, "out");
  const calls = [];

  await prepareSandbox(dataset, paths, "none", { install: false });
  t.after(() => Promise.all([fs.rm(seedRoot, { recursive: true, force: true, maxRetries: 5 }), fs.rm(path.dirname(paths.root), { recursive: true, force: true, maxRetries: 5 })]));

  return { dataset, paths, outDir, calls };
}

// The last line of each commit message, newest first: "Session <id>", or the subject for seed and failed sessions.
function sessionLog(repo, ref = "HEAD") {
  const messages = execFileSync("git", ["log", "--format=%B%x00", ref], { cwd: repo, encoding: "utf8" }).split("\0");
  return messages.map((message) => message.trim().split("\n").pop().replace(/^Session /, "")).filter(Boolean);
}

function fakeSpawn(calls, code = 0) {
  return async (command, args, options) => {
    calls.push(args);
    await fs.appendFile(path.join(options.cwd, "work.txt"), `${args[1]}\n`);
    return { code, stdout: code ? "" : streamLines(success(0.1)) };
  };
}

test("runTimeline resumes turns and commits per session", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(calls) });
  const log = sessionLog(paths.repos.relay);

  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("--session-id"));
  assert.ok(calls[1].includes("--resume"));
  assert.equal(calls[1][calls[1].indexOf("--resume") + 1], calls[0][calls[0].indexOf("--session-id") + 1]);
  assert.deepEqual(log, ["S2", "S1", "seed"]);
  assert.equal(records.length, 2);
  assert.ok(Math.abs(records[0].costUsd - 0.2) < 1e-9);
  assert.equal(records[0].ok, true);
  assert.notEqual(records[0].before, records[0].after);
  assert.ok(fsSync.existsSync(path.join(outDir, "none", "S1.jsonl")));
});

test("runTimeline commits and continues after a failed session", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(calls, 1) });
  const log = execFileSync("git", ["log", "--format=%s"], { cwd: paths.repos.relay, encoding: "utf8" });

  assert.deepEqual(records.map((record) => record.ok), [false, false]);
  assert.deepEqual(log.trim().split("\n"), ["S2", "S1", "seed"]);
});

test("a usage limit stops the timeline and the rerun resumes at that session", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  const limited = async (command, args, options) => {
    calls.push(args);
    await fs.appendFile(path.join(options.cwd, "work.txt"), "partial\n");
    return { code: 1, stdout: streamLines({ type: "result", subtype: "success", is_error: true, api_error_status: 429, total_cost_usd: 0 }) };
  };

  await assert.rejects(runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: limited }), /usage limit/);
  assert.equal(calls.length, 1);
  assert.equal(fsSync.existsSync(path.join(outDir, "none", "S1.json")), false);

  const again = [];
  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(again) });

  assert.equal(again.length, 3);
  assert.deepEqual(records.map((record) => record.ok), [true, true]);
  assert.equal(records[0].retried, true);
  assert.equal(fsSync.readFileSync(path.join(paths.repos.relay, "work.txt"), "utf8").includes("partial"), false);
});

test("each session starts on main even if the last one ended on a branch", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  const branches = [];
  const spawn = async (command, args, options) => {
    branches.push(execFileSync("git", ["branch", "--show-current"], { cwd: options.cwd, encoding: "utf8" }).trim());

    if (calls.length === 0) {
      execFileSync("git", ["checkout", "-q", "-b", "fix/parked"], { cwd: options.cwd });
    }

    return fakeSpawn(calls)(command, args, options);
  };

  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn });
  const parked = sessionLog(paths.repos.relay, "fix/parked");

  assert.deepEqual(branches, ["main", "fix/parked", "main"]);
  assert.deepEqual(parked, ["S1", "seed"]);
  assert.equal(records[1].before, execFileSync("git", ["rev-parse", "main~1"], { cwd: paths.repos.relay, encoding: "utf8" }).trim());
});

test("a rerun refuses a recorded session whose prompts or checks changed", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);

  await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(calls) });
  dataset.sessions.get("S1").turns[0] = "first, reworded";

  await assert.rejects(runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn([]) }), /S1 changed since it ran/);
});

test("commitMessage uses the first line of the agent's summary", () => {
  assert.equal(commitMessage("B5", "**Lowered chunk size to 2,000 rows.**\n\nDetails…"), "Lowered chunk size to 2,000 rows.\n\nSession B5");
  assert.equal(commitMessage("B5", ""), "B5");
  assert.equal(commitMessage("B5", "## `Fixed` it"), "Fixed it\n\nSession B5");
  assert.ok(commitMessage("B5", "word ".repeat(40)).split("\n")[0].length <= 72);
});

test("isOffer detects offers and questions, not code or quoted errors", () => {
  assert.equal(isOffer("Done.\n\nWant me to add it to your user CLAUDE.md?"), true);
  assert.equal(isOffer("Done. Should I also update the README?"), true);
  assert.equal(isOffer("Done.\n\n```\nif (x?) {}\n```"), false);
  assert.equal(isOffer("Fixed the error `Is the server running?`."), false);
  assert.equal(isOffer("All tests pass."), false);
  assert.equal(isOffer(""), false);
});

test("an offer gets exactly one 'yes, go ahead' turn", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  const offering = async (command, args) => {
    calls.push(args);
    return { code: 0, stdout: streamLines({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, result: "Done. Want me to update the docs?" }) };
  };
  const records = await runTimeline({ dataset: { ...dataset, timeline: ["S2"] }, system: "none", paths, outDir, budgetUsd: 3, spawn: offering });

  assert.equal(calls.length, 2);
  assert.equal(calls[1][calls[1].indexOf("-p") + 1], "yes, go ahead");
  assert.ok(calls[1].includes("--resume"));
  assert.equal(records[0].offerReplied, true);
  assert.equal(records[0].turns, 2);
});

test("sessions commit with the agent's summary", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(calls) });
  const log = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: paths.repos.relay, encoding: "utf8" }).trim();

  assert.equal(log, "done\n\nSession S2");
});

test("a retried session restores memory dirs to their state before the attempt", async (t) => {
  const { dataset, paths, outDir } = await runnerFixture(t);
  const kept = path.join(paths.root, "mem");
  const absent = path.join(paths.root, "mem2");
  const adapter = { ...ADAPTERS["cc-none"], memoryDirs: () => [kept, absent] };
  const seen = [];

  await fs.mkdir(kept, { recursive: true });
  await fs.writeFile(path.join(kept, "a.md"), "before\n");
  const limited = async () => {
    await fs.writeFile(path.join(kept, "x.md"), "partial\n");
    await fs.mkdir(absent, { recursive: true });
    await fs.writeFile(path.join(absent, "y.md"), "partial\n");
    return { code: 1, stdout: streamLines({ type: "result", subtype: "success", is_error: true, api_error_status: 429, total_cost_usd: 0 }) };
  };
  const observing = async (command, args, options) => {
    seen.push({ a: fsSync.existsSync(path.join(kept, "a.md")), x: fsSync.existsSync(path.join(kept, "x.md")), absent: fsSync.existsSync(absent) });
    return fakeSpawn([])(command, args, options);
  };

  await assert.rejects(runTimeline({ dataset, system: "none", adapter, paths, outDir, budgetUsd: 3, spawn: limited }), /usage limit/);
  await runTimeline({ dataset, system: "none", adapter, paths, outDir, budgetUsd: 3, spawn: observing });

  assert.deepEqual(seen[0], { a: true, x: false, absent: false });
});

test("runManifest ignores docs and tests but tracks the dataset and harness", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"));
  const datasetDir = path.join(repo, "bench", "continuity");
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  await fs.mkdir(path.join(datasetDir, "scenarios", "relay"), { recursive: true });
  await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
  await fs.mkdir(path.join(repo, "docs"), { recursive: true });
  await fs.writeFile(path.join(datasetDir, "facts.json"), "[]");
  await fs.writeFile(path.join(datasetDir, "scenarios", "relay", "sessions.json"), "[]");
  await fs.writeFile(path.join(repo, "scripts", "eval-continuity.cjs"), "// v1");
  const options = { repoRoot: repo, datasetDir, judgeModel: "m", budgetUsd: 3, versions: { claude: "1" } };
  const first = await runManifest(options);

  await fs.writeFile(path.join(repo, "docs", "x.md"), "edit");
  assert.deepEqual(await runManifest(options), first);

  await fs.appendFile(path.join(datasetDir, "scenarios", "relay", "sessions.json"), " ");
  assert.notEqual((await runManifest(options)).datasetHash, first.datasetHash);

  await fs.writeFile(path.join(repo, "scripts", "eval-continuity.cjs"), "// v2");
  assert.notEqual((await runManifest(options)).harnessHash, first.harnessHash);
});

test("checkManifest writes the first manifest and refuses a different one unless forced", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-run-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifest = { datasetHash: "d", harnessHash: "h", model: "m", judgeModel: "j", budgetUsd: 3, versions: { claude: "1" } };

  await checkManifest(dir, "r1", manifest);
  await checkManifest(dir, "r1", manifest);
  await assert.rejects(checkManifest(dir, "r1", { ...manifest, versions: { claude: "2" } }), /run r1 was started with a different versions/);

  await checkManifest(dir, "r1", { ...manifest, versions: { claude: "2" } }, { force: true });
  const saved = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(saved.changes.length, 1);
  assert.equal(saved.versions.claude, "1");
});

test("assertNoInstructionFiles refuses a sandbox under a folder with agent instructions", async (t) => {
  const top = await fs.mkdtemp(path.join(os.tmpdir(), "instr-"));
  const deep = path.join(top, "a", "b");
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  await fs.mkdir(deep, { recursive: true });

  assert.doesNotThrow(() => assertNoInstructionFiles(deep));
  for (const file of ["CLAUDE.md", "AGENTS.md", path.join(".claude", "CLAUDE.md")]) {
    await fs.mkdir(path.dirname(path.join(top, "a", file)), { recursive: true });
    await fs.writeFile(path.join(top, "a", file), "rules");
    assert.throws(() => assertNoInstructionFiles(deep), new RegExp(path.basename(file)));
    await fs.rm(path.join(top, "a", file));
  }
});

test("an attempt that crashed in its first turn is undone, including the agent's own commits", async (t) => {
  const { dataset, paths, outDir } = await runnerFixture(t);
  const mem = path.join(paths.root, "mem");
  const adapter = { ...ADAPTERS["cc-none"], memoryDirs: () => [mem] };
  const seed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.repos.relay, encoding: "utf8" }).trim();
  const crash = async (command, args, options) => {
    await fs.writeFile(path.join(options.cwd, "crash.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: options.cwd });
    execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "agent commit"], { cwd: options.cwd });
    await fs.mkdir(mem, { recursive: true });
    await fs.writeFile(path.join(mem, "x.md"), "partial");
    throw new Error("killed");
  };
  const seen = [];
  const observing = async (command, args, options) => {
    seen.push({ head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: options.cwd, encoding: "utf8" }).trim(), crash: fsSync.existsSync(path.join(options.cwd, "crash.txt")), mem: fsSync.existsSync(mem) });
    return fakeSpawn([])(command, args, options);
  };

  await assert.rejects(runTimeline({ dataset, system: "none", adapter, paths, outDir, budgetUsd: 3, spawn: crash }), /killed/);
  const records = await runTimeline({ dataset, system: "none", adapter, paths, outDir, budgetUsd: 3, spawn: observing });

  assert.deepEqual(seen[0], { head: seed, crash: false, mem: false });
  assert.equal(records[0].retried, true);
});

test("runManifest does not depend on where the repo is checked out and ignores dotfiles", async (t) => {
  const make = async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-loc-"));
    const datasetDir = path.join(repo, "bench", "continuity");
    await fs.mkdir(datasetDir, { recursive: true });
    await fs.mkdir(path.join(repo, "scripts"), { recursive: true });
    await fs.writeFile(path.join(datasetDir, "facts.json"), "[]");
    await fs.writeFile(path.join(repo, "scripts", "eval-continuity.cjs"), "// same");
    t.after(() => fs.rm(repo, { recursive: true, force: true }));
    return { repoRoot: repo, datasetDir, judgeModel: "m", budgetUsd: 3, versions: {} };
  };
  const a = await make();
  const b = await make();
  await fs.writeFile(path.join(b.datasetDir, ".DS_Store"), "junk");

  assert.deepEqual(await runManifest(a), await runManifest(b));
});

test("checkManifest refuses an old run folder that has sessions but no manifest", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-old-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "hippocamp"));
  await fs.writeFile(path.join(dir, "hippocamp", "A1.json"), "{}");

  await assert.rejects(checkManifest(dir, "v1", { datasetHash: "d" }), /no manifest/);
});

test("memory quality is judged again when a run is extended", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quality-"));
  const file = path.join(dir, "memory-quality.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  assert.equal(await needsQualityJudge(file, "B5"), true);
  await fs.writeFile(file, JSON.stringify({ through: "B5" }));
  assert.equal(await needsQualityJudge(file, "B5"), false);
  assert.equal(await needsQualityJudge(file, "B11"), true);
});

test("writeValidationSheet never overwrites human grades and records the run", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sheet-"));
  const file = path.join(dir, "validation.csv");
  const sessions = new Map([["P1", probe]]);
  const rows = [{ system: "cc-native", run: "r1", probe: "P1", item: "P1-1", fact: "f1", memory: true, pass: true, cause: null, evidence: "e" }];
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await writeValidationSheet(file, rows, { sessions, facts: probeFacts });
  assert.match(await fs.readFile(file, "utf8"), /^run,system,/);
  await fs.writeFile(file, "graded by hand");
  await writeValidationSheet(file, rows, { sessions, facts: probeFacts });
  assert.equal(await fs.readFile(file, "utf8"), "graded by hand");
});

test("completed sessions are skipped on rerun", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);

  await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(calls) });
  const again = [];
  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(again) });

  assert.equal(again.length, 0);
  assert.equal(records.length, 2);
});

test("runTimeline stops at limit", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, limit: 1, spawn: fakeSpawn(calls) });

  assert.deepEqual(records.map((record) => record.id), ["S1"]);
});

test("recallSignals tags hippocamp, native and repo note reads", () => {
  const paths = sandboxPaths("t", "native");
  const signals = recallSignals(
    [
      { name: "mcp__hippocamp__wake_up", input: {} },
      { name: "mcp__hippocamp__search_memory", input: { query: "redis" } },
      { name: "mcp__hippocamp__search_memory", input: { query: "node" } },
      { name: "Read", input: { file_path: path.join(paths.configDir, "projects", "x", "memory", "a.md") } },
      { name: "Bash", input: { command: "cat ~/.claude/projects/x/memory/MEMORY.md" } },
      { name: "Read", input: { file_path: path.join(paths.repos.relay, "NOTES.md") } },
      { name: "Read", input: { file_path: path.join(paths.repos.relay, "README.md") } },
      { name: "Read", input: { file_path: path.join(paths.repos.relay, "src", "server.ts") } },
    ],
    paths,
  );

  assert.deepEqual(signals, ["hippocamp:wake_up", "hippocamp:search_memory", "native:read", "repo-note:NOTES.md"]);
});

test("digest caps length", () => {
  const calls = Array.from({ length: 10000 }, (_, index) => ({ name: "Bash", input: { command: `echo ${index} ${"x".repeat(300)}` } }));
  const digest = transcriptDigest(calls, "final answer");

  assert.ok(digest.length <= 40000, String(digest.length));
  assert.ok(digest.includes("final answer"));
  assert.ok(digest.startsWith("Bash: "));
});

test("memorySnapshot shows every native scope so a wrongly scoped fact is visible", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-snap-"));
  const paths = { ...sandboxPaths("t", "native"), configDir: path.join(root, ".claude"), repos: { relay: path.join(root, "repos", "relay"), ingest: path.join(root, "repos", "ingest") } };

  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await fs.mkdir(path.join(paths.configDir, "projects", "-tmp-repos-relay", "memory"), { recursive: true });
  await fs.mkdir(path.join(paths.configDir, "projects", "-tmp-repos-ingest", "memory"), { recursive: true });
  await fs.writeFile(path.join(paths.configDir, "projects", "-tmp-repos-relay", "memory", "MEMORY.md"), "relay uses postgres\n");
  await fs.writeFile(path.join(paths.configDir, "projects", "-tmp-repos-ingest", "memory", "MEMORY.md"), "ingest uses utc\n");
  await fs.mkdir(paths.repos.relay, { recursive: true });
  await fs.writeFile(path.join(paths.repos.relay, "CLAUDE.md"), "# relay\n");

  const snapshot = await memorySnapshot("native", paths, "relay");

  assert.ok(snapshot.includes("relay uses postgres"));
  assert.ok(snapshot.includes("ingest uses utc"));
  assert.ok(snapshot.includes("# relay"));
});

const probe = {
  id: "P1",
  project: "relay",
  kind: "probe",
  turns: ["add retry metrics"],
  checklist: [
    { id: "P1-1", fact: "f1", check: "Reads Postgres." },
    { id: "P1-2", fact: "f2", check: "No new deps." },
  ],
};
const probeFacts = [
  { id: "f1", kind: "decision", statement: "Postgres." },
  { id: "f2", kind: "preference", statement: "No deps." },
];

test("judge output missing items become failures", async () => {
  let prompt = "";
  const complete = async (model, request) => {
    prompt = request.messages[0].content;
    return { text: '```json\n{"items":[{"id":"P1-1","pass":true,"source":"hippocamp","cause":null}]}\n```', usage: {} };
  };
  const items = await judgeProbe({ session: probe, facts: probeFacts, diff: "diff", digest: "digest", snapshot: "snap", signals: [], judgeModel: "m", complete });

  assert.ok(prompt.includes("Reads Postgres.") && prompt.includes("Postgres."));
  assert.deepEqual(items, [
    { item: "P1-1", pass: true, evidence: "" },
    { item: "P1-2", pass: false, evidence: "", cause: "judge-missing" },
  ]);
});

test("judge asks for and keeps one line of evidence per item", async () => {
  let prompt = "";
  const complete = async (model, request) => {
    prompt = request.messages[0].content;
    return { text: '{"items":[{"id":"P1-1","pass":false,"source":"none","cause":"never-stored","evidence":"load.py sets CHUNK_SIZE = 10_000"},{"id":"P1-2","pass":"n/a","evidence":"no dependency change"}]}', usage: {} };
  };
  const items = await judgeProbe({ session: probe, facts: probeFacts, diff: "", digest: "", snapshot: "", signals: [], judgeModel: "m", complete });

  assert.match(prompt, /"evidence"/);
  assert.deepEqual(items.map((item) => item.evidence), ["load.py sets CHUNK_SIZE = 10_000", "no dependency change"]);
});

test("validationSheet lists each verdict with blank columns for a human grade", () => {
  const sessions = new Map([["P1", probe]]);
  const rows = [{ system: "cc-native", probe: "P1", item: "P1-1", fact: "f1", memory: true, pass: false, cause: "never-stored", evidence: 'set "size" to 10,000' }];
  const lines = validationSheet(rows, { sessions, facts: probeFacts }).trim().split("\n");

  assert.equal(lines[0], "run,system,probe,item,memory,check,fact,judge_pass,judge_cause,evidence,human_pass,human_note");
  assert.equal(lines[1], ',cc-native,P1,P1-1,true,Reads Postgres.,Postgres.,false,never-stored,"set ""size"" to 10,000",,');
});

test("judge reply that is not JSON fails every item", async () => {
  const complete = async () => ({ text: "I think it passes.", usage: {} });
  const items = await judgeProbe({ session: probe, facts: probeFacts, diff: "", digest: "", snapshot: "", signals: [], judgeModel: "m", complete });

  assert.deepEqual(items.map((item) => item.cause), ["judge-missing", "judge-missing"]);
});

test("runTimeline snapshots memory before each probe session runs", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);
  dataset.sessions.get("S2").kind = "probe";
  const seen = [];
  const snapshot = async (session) => {
    seen.push({ id: session.id, callsSoFar: calls.length });
    return `memory before ${session.id}`;
  };

  await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, spawn: fakeSpawn(calls), snapshot });

  assert.deepEqual(seen, [{ id: "S2", callsSoFar: 2 }]);
  assert.equal(await fs.readFile(path.join(outDir, "none", "S2.snapshot.md"), "utf8"), "memory before S2");
  assert.ok(!fsSync.existsSync(path.join(outDir, "none", "S1.snapshot.md")));
});

test("parseArgs validates systems and run ids", () => {
  assert.deepEqual(parseArgs(["--systems", "native,hippocamp", "--limit", "2", "--run", "smoke"]).systems, ["cc-native", "cc-hippocamp"]);
  assert.throws(() => parseArgs(["--systems", "mem0"]), /Unknown arm/);
  assert.throws(() => parseArgs(["--run", "../../etc"]), /--run/);
  assert.throws(() => parseArgs(["--limit", "0"]), /--limit/);
});

test("judge n/a items stay out of the pass rate and leak items are framed as must-not-carry", async () => {
  let prompt = "";
  const leakProbe = { ...probe, checklist: [probe.checklist[0], { ...probe.checklist[1], leak: true }] };
  const complete = async (model, request) => {
    prompt = request.messages[0].content;
    return { text: '{"items":[{"id":"P1-1","pass":"n/a","source":"none","cause":null},{"id":"P1-2","pass":false,"source":"none"}]}', usage: {} };
  };
  const items = await judgeProbe({ session: leakProbe, facts: probeFacts, diff: "", digest: "", snapshot: "", signals: [], judgeModel: "m", complete });

  assert.ok(prompt.includes("must NOT carry over"));
  assert.deepEqual(items, [
    { item: "P1-1", pass: null, evidence: "" },
    { item: "P1-2", pass: false, evidence: "" },
  ]);
});

test("parseStream attaches tool results and the digest shows memory results", () => {
  const parsed = parseStream(
    streamLines(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__hippocamp__wake_up", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "retries live in postgres" }] }] } },
      success(0.1),
    ),
  );

  assert.equal(parsed.toolCalls[0].result, "retries live in postgres");
  assert.ok(transcriptDigest(parsed.toolCalls, "").includes("retries live in postgres"));
});

test("memorySnapshot labels auto-loaded files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-snap-"));
  const paths = { ...sandboxPaths("t", "native"), configDir: path.join(root, ".claude"), repos: { relay: path.join(root, "repos", "relay") } };
  const memoryDir = path.join(paths.configDir, "projects", "-tmp-repos-relay", "memory");

  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), "index\n");
  await fs.writeFile(path.join(memoryDir, "redis.md"), "dropped redis\n");
  await fs.mkdir(paths.repos.relay, { recursive: true });
  await fs.writeFile(path.join(paths.repos.relay, "CLAUDE.md"), "# relay\n");

  const snapshot = await memorySnapshot("native", paths, "relay");

  assert.match(snapshot, /MEMORY\.md \(auto-loaded\)/);
  assert.match(snapshot, /CLAUDE\.md \(auto-loaded\)/);
  assert.match(snapshot, /redis\.md \(needs a read\)/);
});

test("an interrupted session reruns on a clean tree and is flagged retried", async (t) => {
  const { dataset, paths, outDir, calls } = await runnerFixture(t);

  // A started session leaves its saved pre-session head; no record means it never finished.
  await fs.mkdir(path.join(paths.root, ".pre", "S1"), { recursive: true });
  await fs.writeFile(path.join(paths.root, ".pre", "S1", "head"), execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.repos.relay, encoding: "utf8" }));
  await fs.writeFile(path.join(paths.repos.relay, "half-done.txt"), "partial work\n");
  const records = await runTimeline({ dataset, system: "none", paths, outDir, budgetUsd: 3, limit: 1, spawn: fakeSpawn(calls) });
  const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: paths.repos.relay, encoding: "utf8" });

  assert.equal(records[0].retried, true);
  assert.ok(!files.includes("half-done.txt"), files);
});

test("assertSandboxIntact refuses results without their sandbox", async (t) => {
  const { paths, outDir } = await runnerFixture(t);

  await fs.mkdir(path.join(outDir, "none"), { recursive: true });
  await assertSandboxIntact(paths, path.join(outDir, "none"));
  await fs.writeFile(path.join(outDir, "none", "S1.json"), "{}");
  await assertSandboxIntact(paths, path.join(outDir, "none"));
  await fs.rm(path.join(paths.root, ".prepared"));
  await assert.rejects(assertSandboxIntact(paths, path.join(outDir, "none")), /sandbox/);
});

test("claudeEnv prefers the subscription token over an API key", () => {
  const env = claudeEnv("native", sandboxPaths("t", "native"), { PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CONFIG_DIR: "/real" });

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "o");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, sandboxPaths("t", "native").configDir);
});

test("completeViaClaude sends the prompt on stdin with no tools and reads the result", async () => {
  let seen = null;
  const spawn = async (command, args, options) => {
    seen = { command, args, options };
    return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"items":[]}', total_cost_usd: 0.2 }) };
  };
  const response = await completeViaClaude("claude-opus-5-5", { messages: [{ role: "user", content: "grade this" }] }, { spawn, paths: sandboxPaths("t", "judge") });

  assert.equal(seen.command, "claude");
  assert.equal(seen.options.input, "grade this");
  assert.equal(seen.args[seen.args.indexOf("--tools") + 1], "");
  assert.equal(seen.args[seen.args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(seen.options.env.HOME, sandboxPaths("t", "judge").home);
  assert.equal(response.text, '{"items":[]}');
  assert.equal(response.costUsd, 0.2);
});
