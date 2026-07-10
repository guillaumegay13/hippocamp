#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

const COMMANDS = {
  dream: "hippocamp-dream.cjs",
  mcp: "hippocamp-mcp.cjs",
  "install-codex": "install-codex.cjs",
  "install-claude": "install-claude.cjs",
  "upgrade-codex": "install-codex.cjs",
  "upgrade-claude": "install-claude.cjs",
};

function printHelp() {
  console.log(`Hippocamp

Usage:
  hippocamp dream
  hippocamp mcp
  hippocamp install-codex
  hippocamp install-claude
  hippocamp upgrade-codex
  hippocamp upgrade-claude

Commands:
  dream           Run offline Dream memory compaction
  mcp             Run the local MCP server
  install-codex   Install the Hippocamp skill and MCP server into Codex
  install-claude  Install the Hippocamp skill and MCP server into Claude Code
  upgrade-codex   Upgrade the Codex Hippocamp install
  upgrade-claude  Upgrade the Claude Code Hippocamp install
`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
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
