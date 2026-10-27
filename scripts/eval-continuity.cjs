#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { prepareLagoon } = require("./install-common.cjs");
const { ensureClaudeInstructionsInstalled, ensureClaudeSkillInstalled } = require("./install-claude.cjs");

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "..");
const MODEL = "claude-opus-5-5";
const SYSTEMS = ["none", "native", "hippocamp"];
// Native auto-memory lands in <CLAUDE_CONFIG_DIR>/projects/<cwd slug>/memory/*.md (checked live
// with claude 2.1.311): MEMORY.md is the index Claude Code loads, the other files hold one memory each.
const NATIVE_MEMORY_GLOB = ["projects", "*", "memory"];
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
};

// Sandboxes live under the OS temp dir: Claude Code loads CLAUDE.md from parent folders,
// so a sandbox inside this repo would see Hippocamp's own guidance.
function sandboxPaths(runId, system) {
  const root = path.join(os.tmpdir(), "hippocamp-continuity", runId, system);
  const home = path.join(root, "home");

  return {
    root,
    home,
    configDir: path.join(home, ".claude"),
    lagoon: path.join(root, "lagoon"),
    repos: { relay: path.join(root, "repos", "relay"), ingest: path.join(root, "repos", "ingest") },
    mcpConfig: path.join(root, "mcp.json"),
  };
}

async function git(args, cwd) {
  return execFileAsync("git", args, { cwd, env: { ...process.env, ...GIT_IDENTITY }, maxBuffer: 64 * 1024 * 1024 });
}

async function prepareSandbox(dataset, paths, system, { install = true } = {}) {
  const marker = path.join(paths.root, ".prepared");

  if (fsSync.existsSync(marker)) {
    return;
  }

  await fs.rm(paths.root, { recursive: true, force: true });
  await fs.mkdir(paths.configDir, { recursive: true });

  for (const [project, repo] of Object.entries(paths.repos)) {
    await fs.cp(dataset.seeds[project], repo, { recursive: true });

    if (install && fsSync.existsSync(path.join(repo, "package.json"))) {
      await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: repo });
    }

    await git(["init", "-q", "-b", "main"], repo);
    await git(["add", "-A"], repo);
    await git(["commit", "-q", "-m", "seed"], repo);
  }

  if (system === "hippocamp") {
    await prepareLagoon(paths.lagoon);
    await ensureClaudeInstructionsInstalled({ claudeHome: paths.configDir });
    await ensureClaudeSkillInstalled({ claudeHome: paths.configDir, repoRoot: REPO_ROOT });

    for (const [key, value] of [["user.name", GIT_IDENTITY.GIT_AUTHOR_NAME], ["user.email", GIT_IDENTITY.GIT_AUTHOR_EMAIL]]) {
      await git(["config", key, value], paths.lagoon);
    }

    const server = {
      command: process.execPath,
      args: [path.join(REPO_ROOT, "scripts", "hippocamp-mcp.cjs")],
      env: { HIPPOCAMP_GLOBAL_ROOT: paths.lagoon, ...GIT_IDENTITY },
    };
    await fs.writeFile(paths.mcpConfig, `${JSON.stringify({ mcpServers: { hippocamp: server } }, null, 2)}\n`);
  }

  await fs.writeFile(marker, `${new Date().toISOString()}\n`);
}

function claudeEnv(system, paths, baseEnv = process.env) {
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !/^(HIPPOCAMP_|CLAUDE_)/.test(key)));

  Object.assign(env, GIT_IDENTITY, { HOME: paths.home, CLAUDE_CONFIG_DIR: paths.configDir });

  if (system !== "native") {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }

  if (system === "hippocamp") {
    env.HIPPOCAMP_GLOBAL_ROOT = paths.lagoon;
  }

  return env;
}

function claudeArgs({ system, paths, sessionUuid, resume, prompt, budgetUsd }) {
  const args = [
    "-p",
    prompt,
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--max-budget-usd",
    String(budgetUsd),
    resume ? "--resume" : "--session-id",
    sessionUuid,
  ];

  if (system === "hippocamp") {
    args.push("--mcp-config", paths.mcpConfig);
  }

  return args;
}

module.exports = { NATIVE_MEMORY_GLOB, SYSTEMS, claudeArgs, claudeEnv, prepareSandbox, sandboxPaths };
