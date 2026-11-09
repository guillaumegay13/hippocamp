// One adapter per benchmark arm. Each arm is set up the way a developer has it after a normal
// install, inside the sandbox home, so the run measures the product as it ships.
const fsSync = require("node:fs");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const MODEL = "claude-opus-5-5";
const CODEX_MODEL = "gpt-6.1-sol";
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
};
// Wake-up and session-start files: their content is in context before the agent does anything.
const AUTO_LOADED = new Set(["CLAUDE.md", "MEMORY.md", "current_state.md", "open_threads.md", "project.md", "identity.md", "preferences.md"]);
const ALIASES = { none: "cc-none", native: "cc-native", hippocamp: "cc-hippocamp" };

function run(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function markdownFiles(dir) {
  const files = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    const file = path.join(entry.parentPath || entry.path, entry.name);

    if (entry.isFile() && entry.name.endsWith(".md") && !file.includes(`${path.sep}.git${path.sep}`)) {
      files.push(file);
    }
  }

  return files.sort();
}

async function entriesOf(files, isAutoLoaded) {
  return Promise.all(files.map(async (file) => ({ file, text: await fs.readFile(file, "utf8"), autoLoaded: isAutoLoaded(file) })));
}

function claudeEnv(paths, baseEnv) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => key === "CLAUDE_CODE_OAUTH_TOKEN" || !/^(HIPPOCAMP_|CLAUDE_)/.test(key)));

  // A subscription token (claude setup-token) wins: Claude Code would otherwise bill the API key.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }

  return Object.assign(env, GIT_IDENTITY, { HOME: paths.home, CLAUDE_CONFIG_DIR: paths.configDir });
}

// --strict-mcp-config on every arm keeps the account's claude.ai connectors out of the sandbox.
function claudeArgs({ sessionUuid, resume, prompt, budgetUsd }) {
  return ["-p", prompt, "--model", MODEL, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--strict-mcp-config", "--max-budget-usd", String(budgetUsd), resume ? "--resume" : "--session-id", sessionUuid];
}

function touches(call, dir) {
  const input = call.input || {};
  return String(input.file_path || input.path || input.command || input.pattern || "").includes(dir);
}

const nativeMemoryDir = (paths) => path.join(paths.configDir, "projects");
const codexMemoryDir = (paths) => path.join(paths.codexHome, "memories");

// Codex signs in with the ChatGPT subscription in auth.json; the sandbox gets a copy, never the real CODEX_HOME.
function codexEnv(paths, baseEnv) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !/^(HIPPOCAMP_|CLAUDE_|CODEX_)/.test(key) && key !== "OPENAI_API_KEY"));
  return Object.assign(env, GIT_IDENTITY, { HOME: paths.home, CODEX_HOME: paths.codexHome });
}

// A follow-up turn resumes the thread Codex reported on the first turn.
function codexArgs({ sessionUuid, resume, prompt }) {
  const flags = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--model", CODEX_MODEL];
  return resume ? ["exec", "resume", sessionUuid, ...flags, prompt] : ["exec", ...flags, prompt];
}

async function prepareCodex(paths, config, authSource = path.join(os.homedir(), ".codex", "auth.json")) {
  await fs.mkdir(paths.codexHome, { recursive: true });
  await fs.copyFile(authSource, path.join(paths.codexHome, "auth.json"));
  await fs.writeFile(path.join(paths.codexHome, "config.toml"), `model = "${CODEX_MODEL}"\n${config}`);
}

function codexResult(result) {
  if (typeof result === "string") {
    return result;
  }

  return (result?.content || []).map((part) => part.text || "").join("");
}

// Codex exec --json events, mapped to the tool-call shape the judge and the metrics already use.
function parseCodexStream(text) {
  const parsed = { costUsd: 0, ok: false, toolCalls: [], finalText: "", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, durationMs: 0, threadId: null, limited: false };
  const add = (call) => parsed.toolCalls.push({ ...call, resultBytes: Buffer.byteLength(call.result || "") });

  for (const line of text.split("\n")) {
    let event;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const item = event.type === "item.completed" ? event.item || {} : null;

    if (event.type === "thread.started") {
      parsed.threadId = event.thread_id;
    } else if (item?.type === "command_execution") {
      add({ name: "Bash", input: { command: item.command }, result: item.aggregated_output || "" });
    } else if (item?.type === "mcp_tool_call") {
      add({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments || {}, result: item.error ? String(item.error.message || item.error) : codexResult(item.result) });
    } else if (item?.type === "file_change") {
      for (const change of item.changes || []) {
        add({ name: "Edit", input: { file_path: change.path, kind: change.kind }, result: "" });
      }
    } else if (item?.type === "agent_message") {
      parsed.finalText = item.text || "";
    } else if (event.type === "turn.completed") {
      const cached = event.usage?.cached_input_tokens || 0;
      parsed.tokens.input += (event.usage?.input_tokens || 0) - cached;
      parsed.tokens.cacheRead += cached;
      parsed.tokens.output += event.usage?.output_tokens || 0;
      parsed.ok = true;
    } else if (event.type === "turn.failed" || event.type === "error") {
      parsed.ok = false;
      parsed.limited ||= /usage limit|rate limit/i.test(event.message || event.error?.message || "");
    }
  }

  return parsed;
}

const ADAPTERS = {
  "cc-none": {
    harness: "claude",
    prepare: async () => {},
    env: (paths, baseEnv = process.env) => ({ ...claudeEnv(paths, baseEnv), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
    args: claudeArgs,
    memoryDirs: () => [],
    exportMemory: async () => [],
    autoLoaded: async () => [],
    isMemoryCall: () => false,
  },
  // Auto-memory lands in <CLAUDE_CONFIG_DIR>/projects/<cwd slug>/memory/*.md (checked live with
  // claude 2.1.311): MEMORY.md is the index Claude Code loads, the other files hold one memory each.
  "cc-native": {
    harness: "claude",
    prepare: async () => {},
    env: (paths, baseEnv = process.env) => claudeEnv(paths, baseEnv),
    args: claudeArgs,
    memoryDirs: (paths) => [nativeMemoryDir(paths)],
    async exportMemory(paths, project) {
      const userFile = path.join(paths.configDir, "CLAUDE.md");
      const files = [...(fsSync.existsSync(userFile) ? [userFile] : []), ...(await markdownFiles(nativeMemoryDir(paths))).filter((file) => file.includes(`${path.sep}memory${path.sep}`))];
      return entriesOf(files, (file) => file === userFile || (path.basename(file) === "MEMORY.md" && file.includes(`repos-${project}${path.sep}memory${path.sep}`)));
    },
    async autoLoaded(paths, project) {
      return (await this.exportMemory(paths, project)).filter((entry) => entry.autoLoaded);
    },
    isMemoryCall: (call, paths) => touches(call, nativeMemoryDir(paths)) || touches(call, "~/.claude/projects"),
  },
  "cc-hippocamp": {
    harness: "claude",
    async prepare(paths, { spawn = run } = {}) {
      const env = this.env(paths);
      const installer = path.join(REPO_ROOT, "scripts", "install-claude.cjs");
      const installed = await spawn(process.execPath, [installer, "--claude-home", paths.configDir, "--global-root", paths.lagoon], { cwd: paths.root, env });

      if (installed.code !== 0) {
        throw new Error(`Hippocamp installer failed: ${installed.stderr || installed.stdout}`);
      }

      for (const [key, value] of [["user.name", GIT_IDENTITY.GIT_AUTHOR_NAME], ["user.email", GIT_IDENTITY.GIT_AUTHOR_EMAIL]]) {
        await spawn("git", ["-C", paths.lagoon, "config", key, value], { cwd: paths.root, env });
      }

      // `claude mcp add --scope user` writes <CLAUDE_CONFIG_DIR>/.claude.json (checked live with claude 2.1.316).
      // The run passes that same server through --mcp-config, because --strict-mcp-config ignores user scope.
      const server = [path.join(paths.configDir, ".claude.json"), path.join(paths.home, ".claude.json")]
        .filter((file) => fsSync.existsSync(file))
        .map((file) => JSON.parse(fsSync.readFileSync(file, "utf8")).mcpServers?.hippocamp)
        .find(Boolean);

      if (!server) {
        throw new Error("Hippocamp installer did not register the hippocamp MCP server in the sandbox");
      }

      await fs.writeFile(paths.mcpConfig, `${JSON.stringify({ mcpServers: { hippocamp: server } }, null, 2)}\n`);
    },
    env: (paths, baseEnv = process.env) => ({ ...claudeEnv(paths, baseEnv), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
    args: (options) => [...claudeArgs(options), "--mcp-config", options.paths.mcpConfig],
    memoryDirs: (paths) => [paths.lagoon],
    // One entry per event: a daily event file holds a whole day of events. Nothing in the Lagoon is
    // auto-loaded; wake-up files reach the context through the wake_up tool call.
    async exportMemory(paths, project) {
      const entries = [];

      for (const file of await markdownFiles(paths.lagoon)) {
        const parts = path.relative(paths.lagoon, file).split(path.sep);

        if (parts[0] === "projects" && parts[1] !== project) {
          continue;
        }

        const text = await fs.readFile(file, "utf8");
        const events = parts.includes("events") ? text.split(/\n(?=## )/).filter((part) => part.startsWith("## ")) : [text];
        events.forEach((event, index) => entries.push({ file: events.length > 1 ? `${file}#${index + 1}` : file, text: event, autoLoaded: false }));
      }

      return entries;
    },
    // The installer's CLAUDE.md block is in context from the start of every session.
    async autoLoaded(paths) {
      const file = path.join(paths.configDir, "CLAUDE.md");
      return fsSync.existsSync(file) ? [{ file, text: await fs.readFile(file, "utf8"), autoLoaded: true }] : [];
    },
    isMemoryCall: (call, paths) => call.name.startsWith("mcp__hippocamp__") || touches(call, paths.lagoon),
  },
  // Codex memories (stable, off by default) summarizes past sessions in the background into
  // CODEX_HOME/memories. It only picks sessions idle for min_rollout_idle_hours; 0 stands in for the
  // days between real sessions, which the benchmark runs back to back.
  "codex-native": {
    harness: "codex",
    command: "codex",
    parse: parseCodexStream,
    prepare: (paths, { authSource } = {}) => prepareCodex(paths, "[features]\nmemories = true\n\n[memories]\nmin_rollout_idle_hours = 0\n", authSource),
    env: (paths, baseEnv = process.env) => codexEnv(paths, baseEnv),
    args: codexArgs,
    memoryDirs: (paths) => [codexMemoryDir(paths)],
    async exportMemory(paths) {
      const files = (await markdownFiles(codexMemoryDir(paths))).filter((file) => path.basename(file) !== "phase2_workspace_diff.md");
      const entries = await entriesOf(files, (file) => path.basename(file) === "memory_summary.md");
      return entries.filter((entry) => !/No raw memories yet\./.test(entry.text));
    },
    async autoLoaded(paths) {
      return (await this.exportMemory(paths)).filter((entry) => entry.autoLoaded);
    },
    isMemoryCall: (call, paths) => touches(call, codexMemoryDir(paths)),
  },
  "codex-hippocamp": {
    harness: "codex",
    command: "codex",
    parse: parseCodexStream,
    async prepare(paths, { spawn = run, authSource } = {}) {
      await prepareCodex(paths, "", authSource);
      const installer = path.join(REPO_ROOT, "scripts", "install-codex.cjs");
      const installed = await spawn(process.execPath, [installer, "--codex-home", paths.codexHome, "--global-root", paths.lagoon], { cwd: paths.root, env: this.env(paths) });

      if (installed.code !== 0) {
        throw new Error(`Hippocamp installer failed: ${installed.stderr || installed.stdout}`);
      }

      for (const [key, value] of [["user.name", GIT_IDENTITY.GIT_AUTHOR_NAME], ["user.email", GIT_IDENTITY.GIT_AUTHOR_EMAIL]]) {
        await spawn("git", ["-C", paths.lagoon, "config", key, value], { cwd: paths.root, env: this.env(paths) });
      }
    },
    env: (paths, baseEnv = process.env) => codexEnv(paths, baseEnv),
    args: codexArgs,
    memoryDirs: (paths) => [paths.lagoon],
    exportMemory: (paths, project) => ADAPTERS["cc-hippocamp"].exportMemory(paths, project),
    // The installer's AGENTS.md block is in context from the start of every session.
    async autoLoaded(paths) {
      const file = path.join(paths.codexHome, "AGENTS.md");
      return fsSync.existsSync(file) ? [{ file, text: await fs.readFile(file, "utf8"), autoLoaded: true }] : [];
    },
    isMemoryCall: (call, paths) => call.name.startsWith("mcp__hippocamp__") || touches(call, paths.lagoon),
  },
};

const ARMS = Object.keys(ADAPTERS);

function resolveArm(name) {
  const arm = ALIASES[name] || name;

  if (!ADAPTERS[arm]) {
    throw new Error(`Unknown arm: ${name}. Use ${ARMS.join(", ")}.`);
  }

  return arm;
}

module.exports = { ADAPTERS, ARMS, AUTO_LOADED, CODEX_MODEL, GIT_IDENTITY, MODEL, parseCodexStream, resolveArm };
