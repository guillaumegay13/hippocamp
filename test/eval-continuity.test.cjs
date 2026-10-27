const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadDataset } = require("../scripts/continuity-dataset.cjs");
const { claudeArgs, claudeEnv, prepareSandbox, sandboxPaths } = require("../scripts/eval-continuity.cjs");

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
