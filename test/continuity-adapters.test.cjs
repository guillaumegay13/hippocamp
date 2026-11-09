const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ADAPTERS, ARMS, parseCodexStream, resolveArm } = require("../scripts/continuity-adapters.cjs");

async function fixturePaths(t) {
  const root = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "adapters-")));
  const home = path.join(root, "home");
  const paths = {
    root,
    home,
    configDir: path.join(home, ".claude"),
    codexHome: path.join(home, ".codex"),
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

test("arms are the Claude Code and Codex setups, with the old names as aliases", () => {
  assert.deepEqual(ARMS, ["cc-none", "cc-native", "cc-hippocamp", "codex-native", "codex-hippocamp"]);
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

const codexLines = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

test("parseCodexStream reads the thread id, tool calls, tokens and final answer", () => {
  const parsed = parseCodexStream(
    codexLines(
      { type: "thread.started", thread_id: "t-1" },
      { type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "a.py\n", exit_code: 0 } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "hippocamp", tool: "wake_up", arguments: { q: 1 }, result: { content: [{ type: "text", text: "memory" }] } } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "/r/a.py", kind: "add" }] } },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } },
    ),
  );

  assert.equal(parsed.threadId, "t-1");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.finalText, "done");
  assert.deepEqual(parsed.tokens, { input: 40, output: 7, cacheRead: 60, cacheWrite: 0 });
  assert.deepEqual(parsed.toolCalls.map((call) => call.name), ["Bash", "mcp__hippocamp__wake_up", "Edit"]);
  assert.equal(parsed.toolCalls[1].result, "memory");
  assert.equal(parsed.toolCalls[1].resultBytes, 6);
  assert.equal(parsed.toolCalls[2].input.file_path, "/r/a.py");
});

test("parseCodexStream marks failed turns and usage limits", () => {
  assert.equal(parseCodexStream(codexLines({ type: "turn.failed", error: { message: "boom" } })).ok, false);
  assert.equal(parseCodexStream("").ok, false);
  const limited = parseCodexStream(codexLines({ type: "error", message: "You've hit your usage limit. Try again later." }, { type: "turn.failed", error: { message: "usage limit" } }));
  assert.equal(limited.limited, true);
});

test("codex arms run codex exec with sandbox HOME and CODEX_HOME, resuming by thread id", async (t) => {
  const paths = await fixturePaths(t);
  const adapter = ADAPTERS["codex-native"];
  const env = adapter.env(paths, { OPENAI_API_KEY: "k", CODEX_HOME: "/real", PATH: "/bin" });
  const first = adapter.args({ paths, sessionUuid: null, resume: false, prompt: "p" });
  const next = adapter.args({ paths, sessionUuid: "t-1", resume: true, prompt: "q" });

  assert.equal(adapter.command, "codex");
  assert.equal(env.HOME, paths.home);
  assert.equal(env.CODEX_HOME, paths.codexHome);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.deepEqual([first[0], first.at(-1)], ["exec", "p"]);
  assert.ok(first.includes("--json") && first.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.deepEqual(next.slice(0, 3), ["exec", "resume", "t-1"]);
  assert.equal(next.at(-1), "q");
});

test("codex-native turns on Codex memories; codex-hippocamp runs the real Codex installer", async (t) => {
  const paths = await fixturePaths(t);
  const authSource = path.join(paths.root, "auth.json");
  await fs.writeFile(authSource, "{}");
  await ADAPTERS["codex-native"].prepare(paths, { authSource });
  const config = await fs.readFile(path.join(paths.codexHome, "config.toml"), "utf8");

  assert.match(config, /\[features\]\nmemories = true/);
  assert.ok(fsSync.existsSync(path.join(paths.codexHome, "auth.json")));

  const other = await fixturePaths(t);
  await fs.writeFile(path.join(other.root, "auth.json"), "{}");
  const calls = [];
  const spawn = async (command, args, options) => {
    calls.push({ command, args, env: options.env, configAtInstall: fsSync.readFileSync(path.join(other.codexHome, "config.toml"), "utf8") });
    return { code: 0, stdout: "{}", stderr: "" };
  };
  await ADAPTERS["codex-hippocamp"].prepare(other, { spawn, authSource: path.join(other.root, "auth.json") });
  const install = calls.find((call) => call.args.some((arg) => arg.endsWith("install-codex.cjs")));

  assert.deepEqual(install.args.slice(-4), ["--codex-home", other.codexHome, "--global-root", other.lagoon]);
  assert.equal(install.env.CODEX_HOME, other.codexHome);
  assert.doesNotMatch(install.configAtInstall, /memories = true/);
  assert.equal(ADAPTERS["codex-hippocamp"].isMemoryCall({ name: "mcp__hippocamp__search_memory", input: {} }, other), true);
  assert.equal(ADAPTERS["codex-native"].isMemoryCall({ name: "Bash", input: { command: `cat ${path.join(paths.codexHome, "memories", "MEMORY.md")}` } }, paths), true);
});

test("codex-native exports what Codex memories wrote, skipping its empty placeholder", async (t) => {
  const paths = await fixturePaths(t);
  const dir = path.join(paths.codexHome, "memories");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "raw_memories.md"), "# Raw Memories\n\nNo raw memories yet.\n");
  await fs.writeFile(path.join(dir, "phase2_workspace_diff.md"), "diff");
  await fs.writeFile(path.join(dir, "memory_summary.md"), "v1\n- relay uses unittest\n");
  const entries = await ADAPTERS["codex-native"].exportMemory(paths, "relay");

  assert.deepEqual(entries.map((entry) => path.basename(entry.file)), ["memory_summary.md"]);
  assert.equal(entries[0].autoLoaded, true);
});
