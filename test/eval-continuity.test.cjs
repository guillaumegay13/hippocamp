const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadDataset } = require("../scripts/continuity-dataset.cjs");
const { execFileSync } = require("node:child_process");
const { claudeArgs, claudeEnv, parseStream, prepareSandbox, runTimeline, sandboxPaths } = require("../scripts/eval-continuity.cjs");

const DATASET_DIR = path.join(__dirname, "..", "bench", "continuity");

test("sandbox paths are outside the working tree", () => {
  const paths = sandboxPaths("t", "none");

  assert.ok(!paths.root.startsWith(process.cwd()), paths.root);
  assert.ok(paths.root.startsWith(os.tmpdir()), paths.root);
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
  assert.equal(hippocamp.HIPPOCAMP_GLOBAL_ROOT, sandboxPaths("t", "hippocamp").lagoon);
});

test("claudeArgs uses resume after the first turn and mcp only for hippocamp", () => {
  const first = claudeArgs({ system: "native", paths: sandboxPaths("t", "native"), sessionUuid: "u1", resume: false, prompt: "hi", budgetUsd: 3 });
  const later = claudeArgs({ system: "hippocamp", paths: sandboxPaths("t", "hippocamp"), sessionUuid: "u1", resume: true, prompt: "more", budgetUsd: 3 });

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
    await fs.rm(path.dirname(sandboxPaths(runId, "none").root), { recursive: true, force: true });
  }
});

function streamLines(...events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const toolUse = { type: "assistant", message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", name: "mcp__hippocamp__search_memory", input: { query: "retries" } }] } };
const success = (cost) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: "done" });

test("parseStream sums cost and collects tool calls", () => {
  const parsed = parseStream(streamLines({ type: "system", subtype: "init" }, toolUse, success(0.42)));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.costUsd, 0.42);
  assert.equal(parsed.finalText, "done");
  assert.deepEqual(parsed.toolCalls, [{ name: "mcp__hippocamp__search_memory", input: { query: "retries" } }]);
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
  t.after(() => Promise.all([fs.rm(seedRoot, { recursive: true, force: true }), fs.rm(path.dirname(paths.root), { recursive: true, force: true })]));

  return { dataset, paths, outDir, calls };
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
  const log = execFileSync("git", ["log", "--format=%s"], { cwd: paths.repos.relay, encoding: "utf8" });

  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("--session-id"));
  assert.ok(calls[1].includes("--resume"));
  assert.equal(calls[1][calls[1].indexOf("--resume") + 1], calls[0][calls[0].indexOf("--session-id") + 1]);
  assert.deepEqual(log.trim().split("\n"), ["S2", "S1", "seed"]);
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
