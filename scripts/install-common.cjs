const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// How an agent starts the MCP server. Run through npx, the package sits in npm's cache, which
// npm may clean. Copy it with its dependencies to ~/.hippocamp/<version> and start it from
// there: no npx or network at start, so it also works offline.
function mcpServerCommand(repoRoot, home = os.homedir()) {
  if (!repoRoot.split(path.sep).includes("_npx")) {
    return [process.execPath, path.join(repoRoot, "scripts", "hippocamp-mcp.cjs")];
  }

  const { version } = require(path.join(repoRoot, "package.json"));
  const target = path.join(home, ".hippocamp", version, "node_modules");

  // Copy into a staging folder first, so a failed copy never removes a working install.
  const staging = `${target}.staging-${process.pid}`;
  fsSync.rmSync(staging, { recursive: true, force: true });
  fsSync.cpSync(path.dirname(repoRoot), staging, { recursive: true, dereference: true });
  fsSync.rmSync(target, { recursive: true, force: true });
  fsSync.renameSync(staging, target);

  return [process.execPath, path.join(target, path.basename(repoRoot), "scripts", "hippocamp-mcp.cjs")];
}

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || "").trim() };
  }
}

// Make sure the Lagoon memory repo exists, and say what is still missing for sync.
// It never creates a remote or pushes: those reach outside this machine.
async function prepareLagoon(globalRoot) {
  const hints = [];
  let created = false;
  const existed = fsSync.existsSync(globalRoot);
  const empty = !existed || (await fs.readdir(globalRoot)).length === 0;

  await fs.mkdir(globalRoot, { recursive: true });

  // The Lagoon must be its own repo: a folder inside another repo would commit memory there.
  const topLevel = await git(["rev-parse", "--show-toplevel"], globalRoot);
  const ownRepo = topLevel.ok && fsSync.realpathSync(topLevel.stdout) === fsSync.realpathSync(globalRoot);

  if (!ownRepo) {
    if (!empty) {
      hints.push(`${globalRoot} is not its own Git repo. Point --global-root at your Lagoon clone, or run: git -C "${globalRoot}" init`);
      return { root: globalRoot, created: false, remote: null, push: "not_git", hints };
    }

    if (!(await git(["init", "-b", "main"], globalRoot)).ok) {
      throw new Error(`git init failed in ${globalRoot}. Check that Git is installed and the folder is writable.`);
    }

    await git(["commit", "--allow-empty", "-m", "hippocamp: create lagoon"], globalRoot);
    created = true;
  }

  const identity = await Promise.all(["user.name", "user.email"].map((key) => git(["config", key], globalRoot)));

  if (identity.some((value) => !value.stdout)) {
    hints.push('Set a Git identity so memory can be committed: git config --global user.name "Your Name" && git config --global user.email you@example.com');
  }

  const remote = await git(["remote", "get-url", "origin"], globalRoot);
  let push = "no_remote";

  if (!remote.ok) {
    hints.push(`Memory is local only. For a private backup and other machines: gh repo create lagoon --private --source "${globalRoot}" --remote origin --push`);
  } else if ((await git(["rev-parse", "--verify", "HEAD"], globalRoot)).ok) {
    push = (await git(["push", "--dry-run"], globalRoot)).ok ? "ok" : "failed";

    if (push === "failed") {
      hints.push(`Git push from ${globalRoot} failed. Set up auth, then check with git push --dry-run: gh auth login && gh auth setup-git`);
    }
  }

  return { root: globalRoot, created, remote: remote.ok ? remote.stdout : null, push, hints };
}

function printHints(lagoon) {
  for (const hint of lagoon.hints) {
    console.error(`Next: ${hint}`);
  }
}

module.exports = { mcpServerCommand, prepareLagoon, printHints };
