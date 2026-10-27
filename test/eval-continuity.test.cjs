const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadDataset } = require("../scripts/continuity-dataset.cjs");
const { execFileSync } = require("node:child_process");
const {
  assertSandboxIntact,
  claudeArgs,
  claudeEnv,
  completeViaClaude,
  judgeProbe,
  memorySnapshot,
  parseArgs,
  parseStream,
  prepareSandbox,
  recallSignals,
  runTimeline,
  sandboxPaths,
  summarize,
  transcriptDigest,
} = require("../scripts/eval-continuity.cjs");

const DATASET_DIR = path.join(__dirname, "..", "bench", "continuity");

test("sandbox paths are outside the working tree", () => {
  const paths = sandboxPaths("t", "none");

  assert.ok(!paths.root.startsWith(process.cwd()), paths.root);
  assert.ok(paths.root.startsWith(fsSync.realpathSync(os.tmpdir())), paths.root);
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
    await fs.rm(path.dirname(sandboxPaths(runId, "none").root), { recursive: true, force: true, maxRetries: 5 });
  }
});

function streamLines(...events) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const toolUse = { type: "assistant", message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "t0", name: "mcp__hippocamp__search_memory", input: { query: "retries" } }] } };
const success = (cost) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: "done" });

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

test("memorySnapshot reads native memory for its own project only", async (t) => {
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
  assert.ok(!snapshot.includes("ingest uses utc"));
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
    { item: "P1-1", pass: true, source: "hippocamp", cause: null },
    { item: "P1-2", pass: false, source: "none", cause: "judge-missing" },
  ]);
});

test("judge reply that is not JSON fails every item", async () => {
  const complete = async () => ({ text: "I think it passes.", usage: {} });
  const items = await judgeProbe({ session: probe, facts: probeFacts, diff: "", digest: "", snapshot: "", signals: [], judgeModel: "m", complete });

  assert.deepEqual(items.map((item) => item.cause), ["judge-missing", "judge-missing"]);
});

test("summarize buckets by kind and distance", () => {
  const rows = [
    { system: "hippocamp", kind: "decision", distance: 2, pass: true, cause: null },
    { system: "hippocamp", kind: "state", distance: 7, pass: false, cause: "not-recalled" },
    { system: "none", kind: "decision", distance: 4, pass: false, cause: "never-stored" },
  ];
  const records = [
    { system: "hippocamp", ok: true, costUsd: 1.25 },
    { system: "hippocamp", ok: false, costUsd: 0.5 },
    { system: "none", ok: true, costUsd: 1 },
  ];
  const table = summarize(rows, records);
  const hippocampRow = table.split("\n").find((line) => line.startsWith("| hippocamp |"));
  const noneRow = table.split("\n").find((line) => line.startsWith("| none |"));

  assert.ok(hippocampRow.startsWith("| hippocamp | 50% |"), hippocampRow);
  assert.ok(hippocampRow.includes("| $1.75 | 1 |"), hippocampRow);
  assert.ok(noneRow.startsWith("| none | 0% |"), noneRow);
  assert.ok(table.split("\n")[0].includes("| 1-2 | 3-5 | 6+ |"));
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
  assert.deepEqual(parseArgs(["--systems", "native,hippocamp", "--limit", "2", "--run", "smoke"]).systems, ["native", "hippocamp"]);
  assert.throws(() => parseArgs(["--systems", "mem0"]), /Unknown system/);
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
    { item: "P1-1", pass: null, source: "none", cause: null },
    { item: "P1-2", pass: false, source: "none", cause: "unknown" },
  ]);

  const table = summarize(
    [
      { system: "hippocamp", kind: "decision", distance: 2, pass: null, cause: null, memory: true },
      { system: "hippocamp", kind: "decision", distance: 2, pass: true, cause: null, memory: true },
      { system: "hippocamp", kind: "state", distance: 2, pass: false, cause: "ignored", memory: false },
    ],
    [],
  );
  const header = table.split("\n")[0].split(" | ");
  const row = table.split("\n").find((line) => line.startsWith("| hippocamp |")).split(" | ");

  assert.equal(row[1], "50%");
  assert.equal(row[header.indexOf("Memory-only")], "100%");
  assert.equal(row[header.indexOf("N/A")], "1");
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

  await fs.mkdir(path.join(outDir, "none"), { recursive: true });
  await fs.writeFile(path.join(outDir, "none", "S1.jsonl"), "partial\n");
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
