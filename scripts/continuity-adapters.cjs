// One adapter per benchmark arm. Each arm is set up the way a developer has it after a normal
// install, inside the sandbox home, so the run measures the product as it ships.
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const MODEL = "claude-opus-5-5";
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
};

const ARMS = Object.keys(ADAPTERS);

function resolveArm(name) {
  const arm = ALIASES[name] || name;

  if (!ADAPTERS[arm]) {
    throw new Error(`Unknown arm: ${name}. Use ${ARMS.join(", ")}.`);
  }

  return arm;
}

module.exports = { ADAPTERS, ARMS, AUTO_LOADED, GIT_IDENTITY, MODEL, resolveArm };
