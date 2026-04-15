#!/usr/bin/env node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

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
        server,
        note: "Restart Codex to load the installed skill and MCP server.",
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
