#!/usr/bin/env node

const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

// One installer per agent CLI; `install` runs the ones whose CLI is on PATH.
const AGENTS = [
  ["claude", "install-claude.cjs"],
  ["codex", "install-codex.cjs"],
  ["grok", "install-grok.cjs"],
];

const COMMANDS = {
  dream: "hippocamp-dream.cjs",
  mcp: "hippocamp-mcp.cjs",
  "install-codex": "install-codex.cjs",
  "install-claude": "install-claude.cjs",
  "install-grok": "install-grok.cjs",
  "upgrade-codex": "install-codex.cjs",
  "upgrade-claude": "install-claude.cjs",
  "upgrade-grok": "install-grok.cjs",
};

function printHelp() {
  console.log(`Hippocamp

Usage:
  hippocamp install
  hippocamp upgrade
  hippocamp dream
  hippocamp mcp
  hippocamp install-codex
  hippocamp install-claude
  hippocamp install-grok
  hippocamp upgrade-codex
  hippocamp upgrade-claude
  hippocamp upgrade-grok

Commands:
  install         Install into every agent found: Claude Code, Codex, Grok Build
  upgrade         Same as install; run with npx hippocamp@latest
  dream           Run offline Dream memory compaction
  mcp             Run the local MCP server
  install-codex   Install the Hippocamp skill and MCP server into Codex
  install-claude  Install the Hippocamp skill and MCP server into Claude Code
  install-grok    Install the Hippocamp skill and MCP server into Grok Build
  upgrade-codex   Upgrade the Codex Hippocamp install
  upgrade-claude  Upgrade the Claude Code Hippocamp install
  upgrade-grok    Upgrade the Grok Build Hippocamp install
`);
}

// Platform-neutral PATH lookup, so `install` also finds agents on Windows.
function onPath(cli) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD").split(";") : [""];

  return String(process.env.PATH || "")
    .split(path.delimiter)
    .some((dir) => extensions.some((extension) => fs.existsSync(path.join(dir, cli + extension.toLowerCase())) || fs.existsSync(path.join(dir, cli + extension))));
}

function installAll(args) {
  const found = AGENTS.filter(([cli]) => onPath(cli));

  if (!found.length) {
    console.error("No supported agent CLI found on PATH: claude, codex, or grok. Install one, then rerun.");
    process.exit(1);
  }

  // Install every agent found, even when one fails, then report the failures.
  const failed = found.filter(([cli, script]) => {
    console.error(`Installing Hippocamp into ${cli}...`);
    return spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: "inherit" }).status !== 0;
  });

  if (failed.length) {
    console.error(`Install failed for: ${failed.map(([cli]) => cli).join(", ")}`);
    process.exit(1);
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "install" || command === "upgrade") {
    installAll(args);
    return;
  }

  const script = COMMANDS[command];

  if (!script) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code || 0);
  });
}

main();
