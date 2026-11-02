const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ADAPTERS, ARMS, resolveArm } = require("../scripts/continuity-adapters.cjs");

async function fixturePaths(t) {
  const root = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "adapters-")));
  const home = path.join(root, "home");
  const paths = {
    root,
    home,
    configDir: path.join(home, ".claude"),
    lagoon: path.join(root, "lagoon"),
    repos: { relay: path.join(root, "repos", "relay"), ingest: path.join(root, "repos", "ingest") },
    mcpConfig: path.join(root, "mcp.json"),
  };

  await fs.mkdir(paths.configDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return paths;
}

// Stands in for the installer: registers the server the way `claude mcp add --scope user` does.
function fakeInstall(paths, calls) {
  return async (command, args, options) => {
    calls.push({ command, args, env: options.env });

    if (args.some((arg) => arg.endsWith("install-claude.cjs"))) {
      const server = { type: "stdio", command: "node", args: ["x"], env: { HIPPOCAMP_AGENT: "claude", HIPPOCAMP_GLOBAL_ROOT: paths.lagoon } };
      await fs.writeFile(path.join(paths.configDir, ".claude.json"), JSON.stringify({ mcpServers: { hippocamp: server } }));
    }

    return { code: 0, stdout: "{}", stderr: "" };
  };
}

test("arms are the three Claude Code setups, with the old names as aliases", () => {
  assert.deepEqual(ARMS, ["cc-none", "cc-native", "cc-hippocamp"]);
  assert.equal(resolveArm("native"), "cc-native");
  assert.equal(resolveArm("cc-hippocamp"), "cc-hippocamp");
  assert.throws(() => resolveArm("mem0"), /Unknown arm/);
});

test("cc-hippocamp runs the real installer with sandbox HOME only", async (t) => {
  const paths = await fixturePaths(t);
  const calls = [];
  await ADAPTERS["cc-hippocamp"].prepare(paths, { spawn: fakeInstall(paths, calls) });
  const install = calls.find((call) => call.args.some((arg) => arg.endsWith("install-claude.cjs")));

  assert.ok(install);
  assert.equal(install.env.HOME, paths.home);
  assert.equal(install.env.CLAUDE_CONFIG_DIR, paths.configDir);
  assert.deepEqual(install.args.slice(-4), ["--claude-home", paths.configDir, "--global-root", paths.lagoon]);
  assert.ok(calls.every((call) => !call.env || call.env.HOME === paths.home), "every spawn stays in the sandbox");
});

test("cc-hippocamp passes the server the installer registered, under strict MCP config", async (t) => {
  const paths = await fixturePaths(t);
  await ADAPTERS["cc-hippocamp"].prepare(paths, { spawn: fakeInstall(paths, []) });
  const args = ADAPTERS["cc-hippocamp"].args({ paths, sessionUuid: "u", resume: false, prompt: "p", budgetUsd: 3 });
  const config = JSON.parse(fsSync.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));

  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(config.mcpServers.hippocamp.env.HIPPOCAMP_AGENT, "claude");
});

test("cc-hippocamp prepare fails loudly when the installer registered nothing", async (t) => {
  const paths = await fixturePaths(t);
  const spawn = async () => ({ code: 0, stdout: "", stderr: "" });

  await assert.rejects(ADAPTERS["cc-hippocamp"].prepare(paths, { spawn }), /did not register/);
});

test("auto-memory is off for cc-none and cc-hippocamp and on for cc-native", async (t) => {
  const paths = await fixturePaths(t);

  assert.equal(ADAPTERS["cc-none"].env(paths, {}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(ADAPTERS["cc-hippocamp"].env(paths, {}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(ADAPTERS["cc-native"].env(paths, {}).CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
  assert.ok(!ADAPTERS["cc-native"].args({ paths, sessionUuid: "u", resume: false, prompt: "p", budgetUsd: 3 }).includes("--mcp-config"));
});

test("exportMemory returns every scope: native includes other projects and user CLAUDE.md", async (t) => {
  const paths = await fixturePaths(t);
  const slug = (project) => path.join(paths.configDir, "projects", `-x-repos-${project}`, "memory");

  for (const project of ["relay", "ingest"]) {
    await fs.mkdir(slug(project), { recursive: true });
    await fs.writeFile(path.join(slug(project), "MEMORY.md"), `- ${project} index\n`);
    await fs.writeFile(path.join(slug(project), "fact.md"), `${project} fact\n`);
  }

  await fs.writeFile(path.join(paths.configDir, "CLAUDE.md"), "user rules\n");
  const entries = await ADAPTERS["cc-native"].exportMemory(paths, "ingest");
  const loaded = entries.filter((entry) => entry.autoLoaded).map((entry) => path.relative(paths.configDir, entry.file));

  assert.ok(entries.some((entry) => entry.file.includes("repos-relay")));
  assert.ok(entries.some((entry) => entry.file.endsWith(`.claude${path.sep}CLAUDE.md`)));
  assert.deepEqual(loaded.sort(), ["CLAUDE.md", path.join("projects", "-x-repos-ingest", "memory", "MEMORY.md")].sort());
  assert.deepEqual(await ADAPTERS["cc-none"].exportMemory(paths, "ingest"), []);
});

test("isMemoryCall recognizes each arm's memory access", async (t) => {
  const paths = await fixturePaths(t);
  const nativeRead = { name: "Read", input: { file_path: path.join(paths.configDir, "projects", "s", "memory", "a.md") } };

  assert.equal(ADAPTERS["cc-hippocamp"].isMemoryCall({ name: "mcp__hippocamp__search_memory", input: {} }, paths), true);
  assert.equal(ADAPTERS["cc-native"].isMemoryCall(nativeRead, paths), true);
  assert.equal(ADAPTERS["cc-native"].isMemoryCall({ name: "Read", input: { file_path: path.join(paths.repos.relay, "src", "a.ts") } }, paths), false);
  assert.equal(ADAPTERS["cc-none"].isMemoryCall(nativeRead, paths), false);
});

test("hippocamp counts only the user CLAUDE.md as auto-loaded; wake-up files arrive through a tool call", async (t) => {
  const paths = await fixturePaths(t);
  await fs.mkdir(path.join(paths.lagoon, "projects", "relay"), { recursive: true });
  await fs.writeFile(path.join(paths.lagoon, "projects", "relay", "current_state.md"), "state");
  await fs.writeFile(path.join(paths.configDir, "CLAUDE.md"), "guidance");
  const loaded = await ADAPTERS["cc-hippocamp"].autoLoaded(paths, "relay");

  assert.deepEqual(loaded.map((entry) => path.basename(entry.file)), ["CLAUDE.md"]);
  assert.ok((await ADAPTERS["cc-hippocamp"].exportMemory(paths, "relay")).every((entry) => !entry.autoLoaded));
});

test("hippocamp exports one entry per event and keeps project scope exact", async (t) => {
  const paths = await fixturePaths(t);
  const events = path.join(paths.lagoon, "projects", "relay", "events");
  await fs.mkdir(events, { recursive: true });
  await fs.mkdir(path.join(paths.lagoon, "projects", "relay-x"), { recursive: true });
  await fs.writeFile(path.join(events, "2026-11-02.md"), "# Events\n\n## 10:00 one\nfirst\n\n## 11:00 two\nsecond\n");
  const entries = await ADAPTERS["cc-hippocamp"].exportMemory(paths, "relay");

  assert.deepEqual(entries.map((entry) => entry.text.trim().split("\n")[0]), ["## 10:00 one", "## 11:00 two"]);
});
