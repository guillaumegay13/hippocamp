#!/usr/bin/env node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const CLAUDE_MANAGED_START = "<!-- hippocamp:managed:start -->";
const CLAUDE_MANAGED_END = "<!-- hippocamp:managed:end -->";
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
    claudeHome: expandHomePath("~/.claude"),
    globalRoot: expandHomePath(process.env.HIPPOCAMP_GLOBAL_ROOT || "~/.lagoon"),
    serverName: "hippocamp",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--claude-home") {
      options.claudeHome = path.resolve(expandHomePath(argv[index + 1]));
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
  console.log(`Install Hippocamp into Claude Code.

Usage:
  node scripts/install-claude.cjs [--claude-home PATH] [--global-root PATH] [--server-name NAME]

Defaults:
  --claude-home  ~/.claude
  --global-root  ~/.lagoon
  --server-name  hippocamp
`);
}

async function runClaude(args) {
  try {
    const result = await execFileAsync("claude", args);
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

function buildClaudeManagedBlock() {
  return [
    CLAUDE_MANAGED_START,
    "# Hippocamp",
    "",
    "- At the start of every top-level task, call the `wake_up` MCP tool.",
    "- Only call `search_memory` if the wake-up files are insufficient.",
    "- Use project memory for project-specific state and global memory for durable personal context.",
    "- After meaningful code or content changes, checkpoint project memory before the final response.",
    "- When project state changes, use `append_event` for milestones and update curated files such as `current_state.md` and `open_threads.md` before finishing the task.",
    "- If a project-memory write does not sync automatically, call `sync_memory` before finishing the task.",
    "- Before writing, reviewing, or refactoring code, read and follow `/Users/guillaumegay/.agents/skills/karpathy-guidelines/SKILL.md` unless the user explicitly asks to skip it.",
    CLAUDE_MANAGED_END,
    "",
  ].join("\n");
}

function upsertManagedBlock(existingContent, block) {
  if (!existingContent) {
    return block;
  }

  const startIndex = existingContent.indexOf(CLAUDE_MANAGED_START);
  const endIndex = existingContent.indexOf(CLAUDE_MANAGED_END);

  if (startIndex >= 0 && endIndex >= 0 && endIndex >= startIndex) {
    const before = existingContent.slice(0, startIndex).trimEnd();
    const after = existingContent.slice(endIndex + CLAUDE_MANAGED_END.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n").concat("\n");
  }

  return `${existingContent.trimEnd()}\n\n${block}`;
}

async function ensureClaudeInstructionsInstalled({ claudeHome }) {
  const claudeMdPath = path.join(claudeHome, "CLAUDE.md");
  const existingContent = await fs.readFile(claudeMdPath, "utf8").catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }

    throw error;
  });
  const nextContent = upsertManagedBlock(existingContent, buildClaudeManagedBlock());

  await fs.mkdir(claudeHome, { recursive: true });
  await fs.writeFile(claudeMdPath, nextContent, "utf8");

  return claudeMdPath;
}

async function copyDirectory(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function ensureClaudeSkillInstalled({ claudeHome, repoRoot }) {
  const sourceDir = path.join(repoRoot, "skills", HIPPOCAMP_SKILL_NAME);
  const skillsDir = path.join(claudeHome, "skills");
  const targetDir = path.join(skillsDir, HIPPOCAMP_SKILL_NAME);
  const legacyAgentPath = path.join(claudeHome, "agents", `${HIPPOCAMP_SKILL_NAME}.md`);

  await copyDirectory(sourceDir, targetDir);
  await fs.rm(legacyAgentPath, { force: true }).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }

    throw error;
  });

  return targetDir;
}

async function ensureServerInstalled({ repoRoot, globalRoot, serverName }) {
  const existing = await runClaude(["mcp", "get", serverName]);

  if (existing.ok) {
    const removed = await runClaude(["mcp", "remove", "--scope", "user", serverName]);

    if (!removed.ok) {
      throw new Error(removed.stderr || `Failed to remove existing MCP server: ${serverName}`);
    }
  }

  const scriptPath = path.join(repoRoot, "scripts", "hippocamp-mcp.cjs");
  const added = await runClaude([
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    serverName,
    "--env",
    `HIPPOCAMP_GLOBAL_ROOT=${globalRoot}`,
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
    summary: added.stdout || added.stderr,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");

  await fs.mkdir(options.claudeHome, { recursive: true });

  const claudeMdPath = await ensureClaudeInstructionsInstalled({
    claudeHome: options.claudeHome,
  });
  const claudeSkillPath = await ensureClaudeSkillInstalled({
    claudeHome: options.claudeHome,
    repoRoot,
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
        claudeHome: options.claudeHome,
        claudeMdPath,
        claudeSkillPath,
        server,
        note: "Restart Claude Code to load the installed MCP server, Hippocamp skill, and refreshed CLAUDE.md instructions.",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to install Hippocamp into Claude Code:", error.message);
  process.exit(1);
});
