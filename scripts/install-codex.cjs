#!/usr/bin/env node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const CODEX_MANAGED_START = "<!-- hippocamp:managed:start -->";
const CODEX_MANAGED_END = "<!-- hippocamp:managed:end -->";

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
    codexHome: expandHomePath(process.env.CODEX_HOME || "~/.codex"),
    globalRoot: expandHomePath(process.env.HIPPOCAMP_GLOBAL_ROOT || "~/.lagoon"),
    serverName: "hippocamp",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--codex-home") {
      options.codexHome = path.resolve(expandHomePath(argv[index + 1]));
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
  console.log(`Install Hippocamp into Codex.

Usage:
  node scripts/install-codex.cjs [--codex-home PATH] [--global-root PATH] [--server-name NAME]

Defaults:
  --codex-home   ~/.codex
  --global-root  ~/.lagoon
  --server-name  hippocamp
`);
}

async function runCodex(args) {
  try {
    const result = await execFileAsync("codex", args);
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

async function ensureSkillInstalled({ repoRoot, codexHome }) {
  const sourceDir = path.join(repoRoot, "skills", "hippocamp-memory");
  const targetDir = path.join(codexHome, "skills", "hippocamp-memory");

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(path.join(sourceDir, "SKILL.md"), path.join(targetDir, "SKILL.md"));

  return targetDir;
}

function buildCodexManagedBlock() {
  return [
    CODEX_MANAGED_START,
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
    "- If the user asks to upgrade Hippocamp for Codex, run `npx hippocamp@latest upgrade-codex`; from a source checkout, run `git pull --ff-only`, `npm install`, then `npm run upgrade:codex`.",
    CODEX_MANAGED_END,
    "",
  ].join("\n");
}

function upsertManagedBlock(existingContent, block) {
  if (!existingContent) {
    return block;
  }

  const startIndex = existingContent.indexOf(CODEX_MANAGED_START);
  const endIndex = existingContent.indexOf(CODEX_MANAGED_END);

  if (startIndex >= 0 && endIndex >= 0 && endIndex >= startIndex) {
    const before = existingContent.slice(0, startIndex).trimEnd();
    const after = existingContent.slice(endIndex + CODEX_MANAGED_END.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n").concat("\n");
  }

  return `${existingContent.trimEnd()}\n\n${block}`;
}

async function ensureCodexInstructionsInstalled({ codexHome }) {
  const agentsMdPath = path.join(codexHome, "AGENTS.md");
  const existingContent = await fs.readFile(agentsMdPath, "utf8").catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }

    throw error;
  });
  const nextContent = upsertManagedBlock(existingContent, buildCodexManagedBlock());

  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(agentsMdPath, nextContent, "utf8");

  return agentsMdPath;
}

async function ensureServerInstalled({ repoRoot, globalRoot, serverName }) {
  const existing = await runCodex(["mcp", "get", serverName, "--json"]);

  if (existing.ok) {
    const removed = await runCodex(["mcp", "remove", serverName]);

    if (!removed.ok) {
      throw new Error(removed.stderr || `Failed to remove existing MCP server: ${serverName}`);
    }
  }

  const scriptPath = path.join(repoRoot, "scripts", "hippocamp-mcp.cjs");
  const added = await runCodex([
    "mcp",
    "add",
    serverName,
    "--env",
    `HIPPOCAMP_GLOBAL_ROOT=${globalRoot}`,
    "--env",
    "HIPPOCAMP_AGENT=codex",
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

  await fs.mkdir(options.codexHome, { recursive: true });

  const skillPath = await ensureSkillInstalled({
    repoRoot,
    codexHome: options.codexHome,
  });
  const codexInstructionsPath = await ensureCodexInstructionsInstalled({
    codexHome: options.codexHome,
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
        codexHome: options.codexHome,
        skillPath,
        codexInstructionsPath,
        server,
        note: "Restart Codex to load the installed skill, MCP server, and refreshed AGENTS.md instructions.",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("Failed to install Hippocamp into Codex:", error.message);
  process.exit(1);
});
