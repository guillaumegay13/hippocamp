#!/usr/bin/env node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const GROK_MANAGED_START = "<!-- hippocamp:managed:start -->";
const GROK_MANAGED_END = "<!-- hippocamp:managed:end -->";
const HIPPOCAMP_SKILL_NAME = "hippocamp-memory";

function expandHomePath(value) {
  if (!value) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function parseArgs(argv) {
  const options = {
    grokHome: expandHomePath(process.env.GROK_HOME || "~/.grok"),
    globalRoot: expandHomePath(process.env.HIPPOCAMP_GLOBAL_ROOT || "~/.lagoon"),
    serverName: "hippocamp",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--grok-home") {
      options.grokHome = path.resolve(expandHomePath(argv[index + 1]));
      index += 1;
      continue;
    }

    if (token === "--global-root") {
      options.globalRoot = path.resolve(expandHomePath(argv[index + 1]));
      index += 1;
      continue;
    }

    if (token === "--server-name") {
      options.serverName = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--help") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printHelp() {
  console.log(`Install Hippocamp into Grok Build.

Usage:
  node scripts/install-grok.cjs [--grok-home PATH] [--global-root PATH] [--server-name NAME]

Defaults:
  --grok-home    ~/.grok
  --global-root  ~/.lagoon
  --server-name  hippocamp
`);
}

async function runGrok(args) {
  try {
    const result = await execFileAsync("grok", args);
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || error.message,
    };
  }
}

async function ensureSkillInstalled({ repoRoot, grokHome }) {
  const sourceDir = path.join(repoRoot, "skills", HIPPOCAMP_SKILL_NAME);
  const targetDir = path.join(grokHome, "skills", HIPPOCAMP_SKILL_NAME);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(path.join(sourceDir, "SKILL.md"), path.join(targetDir, "SKILL.md"));

  return targetDir;
}

function buildGrokManagedBlock() {
  return [
    GROK_MANAGED_START,
    "# Hippocamp",
    "",
    "- For every new top-level coding task, call the Hippocamp `wake_up` MCP tool before inspecting repository files, planning, or editing.",
    "- Read the returned global and project memory before using other memory tools.",
    "- Do this even when the user does not explicitly mention memory.",
    "- Use `search_memory` as the normal path for task-specific recall after wake-up.",
    "- If `search_memory` returns no result, continue without memory instead of reading whole event logs as a fallback.",
    "- If `wake_up` is unavailable or fails, say so explicitly and continue without memory instead of silently skipping it.",
    "- After meaningful code or content changes, checkpoint project memory before the final response.",
    "- When project state changes, use `append_event` for milestones and update curated files such as `current_state.md` and `open_threads.md` before finishing the task.",
    "- When appending events, include concise `Cues:` values or pass the `cues` argument so fuzzy recall can find the event later.",
    "- Do not duplicate commits, PRs, issues, reviews, or CI results in memory; store references plus the missing rationale, preference, assumption, or follow-up context.",
    "- If a project-memory write does not sync automatically, call `sync_memory` before finishing the task.",
    "- If the user asks to upgrade Hippocamp for Grok Build, run `npx hippocamp@latest upgrade-grok`; from a source checkout, run `git pull --ff-only`, `npm install`, then `npm run upgrade:grok`.",
    GROK_MANAGED_END,
    "",
  ].join("\n");
}

function upsertManagedBlock(existingContent, block) {
  if (!existingContent) {
    return block;
  }

  const startIndex = existingContent.indexOf(GROK_MANAGED_START);
  const endIndex = existingContent.indexOf(GROK_MANAGED_END);

  if (startIndex >= 0 && endIndex >= 0 && endIndex >= startIndex) {
    const before = existingContent.slice(0, startIndex).trimEnd();
    const after = existingContent.slice(endIndex + GROK_MANAGED_END.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n").concat("\n");
  }

  return `${existingContent.trimEnd()}\n\n${block}`;
}

async function ensureGrokInstructionsInstalled({ grokHome }) {
  const rulesDir = path.join(grokHome, "rules");
  const rulesPath = path.join(rulesDir, "hippocamp.md");
  const existingContent = await fs.readFile(rulesPath, "utf8").catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }

    throw error;
  });
  const nextContent = upsertManagedBlock(existingContent, buildGrokManagedBlock());

  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(rulesPath, nextContent, "utf8");

  return rulesPath;
}

async function ensureServerInstalled({ repoRoot, globalRoot, serverName }) {
  const existing = await runGrok(["mcp", "list"]);

  if (!existing.ok && /not found|command not found|ENOENT/i.test(existing.stderr)) {
    throw new Error(
      existing.stderr ||
        "grok CLI not found. Install Grok Build and ensure `grok` is on PATH, then retry.",
    );
  }

  const listed = `${existing.stdout}\n${existing.stderr}`;
  const hasServer =
    existing.ok &&
    listed
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith(`${serverName}:`) || line.trim() === serverName);

  if (hasServer) {
    const removed = await runGrok(["mcp", "remove", serverName]);

    if (!removed.ok && !/no mcp server named/i.test(removed.stderr || "")) {
      throw new Error(removed.stderr || `Failed to remove existing MCP server: ${serverName}`);
    }
  }

  const scriptPath = path.join(repoRoot, "scripts", "hippocamp-mcp.cjs");
  const added = await runGrok([
    "mcp",
    "add",
    serverName,
    "-e",
    `HIPPOCAMP_GLOBAL_ROOT=${globalRoot}`,
    "-e",
    "HIPPOCAMP_AGENT=grok",
    "--",
    process.execPath,
    scriptPath,
  ]);

  if (!added.ok) {
    throw new Error(added.stderr || `Failed to add MCP server: ${serverName}`);
  }

  return {
    name: serverName,
    command: process.execPath,
    scriptPath,
    globalRoot,
    agent: "grok",
    summary: added.stdout || added.stderr,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");

  await fs.mkdir(options.grokHome, { recursive: true });

  const skillPath = await ensureSkillInstalled({
    repoRoot,
    grokHome: options.grokHome,
  });
  const grokInstructionsPath = await ensureGrokInstructionsInstalled({
    grokHome: options.grokHome,
  });

  const server = await ensureServerInstalled({
    repoRoot,
    globalRoot: options.globalRoot,
    serverName: options.serverName,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        grokHome: options.grokHome,
        skillPath,
        grokInstructionsPath,
        server,
        note: "Restart Grok Build (or start a new session) to load the installed skill, MCP server, and home rules.",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to install Hippocamp into Grok Build:", error.message);
  process.exit(1);
});
