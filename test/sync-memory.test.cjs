const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const memory = require("../scripts/hippocamp-memory.cjs");

test("sync commits when the Lagoon path goes through a symlink", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-symlink-"));
  const realLagoon = path.join(tempRoot, "real-lagoon");
  const linkedLagoon = path.join(tempRoot, "linked-lagoon");
  const projectRoot = path.join(tempRoot, "linked-project");
  const git = (args) => execFileSync("git", args, { cwd: realLagoon }).toString().trim();

  // CI runners have no Git identity; set one for this test only.
  const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const saved = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  await fs.mkdir(realLagoon);
  await fs.symlink(realLagoon, linkedLagoon);
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  process.env.HIPPOCAMP_GLOBAL_ROOT = linkedLagoon;
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  const result = await memory.appendEvent({
    content: "Use advisory locks.",
    keywords: ["locks"],
    projectRoot,
    scope: "project",
    title: "Queue decision",
  });

  assert.equal(result.sync.committed, true);
  assert.match(git(["log", "--format=%s", "-1"]), /append project event/);

  // A symlink inside the Lagoon pointing at another project must not be synced as this one.
  const otherProject = path.join(tempRoot, "other-project");
  await fs.mkdir(path.join(realLagoon, "projects", "other-project"), { recursive: true });
  await fs.symlink(path.join(realLagoon, "projects", "linked-project", "events"), path.join(realLagoon, "projects", "other-project", "events"));

  await assert.rejects(
    memory.appendEvent({ content: "Cross write.", keywords: ["x"], projectRoot: otherProject, scope: "project", title: "Escape" }),
    /escapes the memory root/,
  );
});

test("sync pushes commits left behind by an earlier failed push", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-backlog-"));
  const remote = path.join(tempRoot, "remote.git");
  const lagoon = path.join(tempRoot, "lagoon");
  const projectRoot = path.join(tempRoot, "project");
  const git = (args, cwd = lagoon) => execFileSync("git", args, { cwd }).toString().trim();

  const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const saved = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  git(["init", "-q", "--bare", "-b", "main", remote], tempRoot);
  git(["clone", "-q", remote, lagoon], tempRoot);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  git(["push", "-q", "-u", "origin", "main"]);
  process.env.HIPPOCAMP_GLOBAL_ROOT = lagoon;
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  // Simulate an unreachable remote for the first write.
  git(["remote", "set-url", "origin", path.join(tempRoot, "missing.git")]);
  const write = await memory.appendEvent({ content: "Use HTTPS.", keywords: ["sync"], projectRoot, scope: "project", title: "Remote" });
  assert.equal(write.sync.committed, true);
  assert.equal(write.sync.pushed, false);

  git(["remote", "set-url", "origin", remote]);
  const result = await memory.syncMemory({
    scope: "project",
    projectRoot,
    paths: await memory.getDefaultSyncPaths("project", projectRoot),
    message: "sync",
  });

  assert.equal(result.committed, false);
  assert.equal(result.pushed, true);
  assert.equal(git(["rev-parse", "main"], remote), git(["rev-parse", "HEAD"]));
});

function withGitIdentity(t) {
  const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const saved = Object.fromEntries(Object.keys({ ...identity, HIPPOCAMP_GLOBAL_ROOT: 1 }).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function createSyncClones(t) {
  withGitIdentity(t);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-sync-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 }));
  const remote = path.join(tempRoot, "remote.git");
  const lagoon = path.join(tempRoot, "lagoon");
  const other = path.join(tempRoot, "other");
  const git = (args, cwd = lagoon) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git(["init", "-q", "--bare", "-b", "main", remote], tempRoot);
  git(["clone", "-q", remote, lagoon], tempRoot);
  await fs.writeFile(path.join(lagoon, "identity.md"), "Initial identity\n");
  git(["add", "identity.md"]);
  git(["commit", "-qm", "init"]);
  git(["push", "-qu", "origin", "main"]);
  git(["clone", "-q", remote, other], tempRoot);
  process.env.HIPPOCAMP_GLOBAL_ROOT = lagoon;
  return { git, lagoon, other, remote };
}

test("sync preserves a dirty curated file when Dream changes it upstream", async (t) => {
  const { git, lagoon, other } = await createSyncClones(t);
  await fs.writeFile(path.join(other, "identity.md"), "Dream rewrite\n");
  git(["commit", "-qam", "Dream rewrite"], other);
  git(["push", "-q"], other);
  await fs.writeFile(path.join(lagoon, "identity.md"), "Local correction\n");
  // Also guard against an autostash preference in the user's Git config.
  git(["config", "rebase.autoStash", "true"]);
  git(["config", "merge.autoStash", "true"]);

  const result = await memory.appendEvent({ scope: "global", content: "Keep me.", title: "Local event" });

  assert.equal(result.sync.committed, true);
  assert.equal(result.sync.pushed, false);
  assert.equal(result.sync.reason, "dirty_worktree");
  assert.match(git(["status", "--porcelain"]), /^M identity\.md$/);
  assert.equal(await fs.readFile(path.join(lagoon, "identity.md"), "utf8"), "Local correction\n");
  assert.equal(git(["stash", "list"]), "");
  assert.equal(git(["rev-list", "--count", "@{u}..HEAD"]), "1");
});

test("sync rolls back a conflicting rebase and retains the unpushed commit", async (t) => {
  const { git, lagoon, other } = await createSyncClones(t);
  await fs.writeFile(path.join(other, "identity.md"), "Remote edit\n");
  git(["commit", "-qam", "remote edit"], other);
  git(["push", "-q"], other);

  const { sync } = await memory.writeMemoryFile({ scope: "global", path: "identity.md", content: "Local edit" });

  assert.equal(sync.committed, true);
  assert.equal(sync.pushed, false);
  assert.equal(sync.reason, "rebase_conflict");
  assert.deepEqual(sync.conflictingPaths, ["identity.md"]);
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(git(["symbolic-ref", "--short", "HEAD"]), "main");
  assert.equal(git(["show", "HEAD:identity.md"]), "Local edit");
  assert.equal(await fs.readFile(path.join(lagoon, "identity.md"), "utf8"), "Local edit\n");
  assert.equal(git(["rev-list", "--count", "@{u}..HEAD"]), "1");
});

test("sync integrates independent writes from another clone and pushes the backlog", async (t) => {
  const { git, lagoon, other, remote } = await createSyncClones(t);
  await fs.writeFile(path.join(other, "identity.md"), "Remote edit\n");
  git(["commit", "-qam", "remote edit"], other);
  git(["push", "-q"], other);
  await fs.writeFile(path.join(lagoon, "scratch.md"), "Untracked note\n");

  const result = await memory.appendEvent({ scope: "global", content: "Keep me.", title: "Local event" });

  assert.equal(result.sync.pushed, true);
  assert.equal(git(["status", "--porcelain"]), "?? scratch.md");
  assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "main"], remote));
  assert.equal(git(["show", "HEAD:identity.md"]), "Remote edit");
  assert.match(git(["show", `HEAD:${result.path}`]), /Local event/);
});

test("sync leaves a rebase started outside Hippocamp untouched", async (t) => {
  const { git, lagoon, other } = await createSyncClones(t);
  await fs.writeFile(path.join(other, "identity.md"), "Remote edit\n");
  git(["commit", "-qam", "remote edit"], other);
  git(["push", "-q"], other);
  await fs.writeFile(path.join(lagoon, "identity.md"), "Local edit\n");
  git(["commit", "-qam", "local edit"]);
  git(["fetch", "-q"]);
  assert.throws(() => git(["rebase", "@{u}"]), /could not apply/);
  const before = git(["status", "--porcelain"]);

  const sync = await memory.syncMemory({ scope: "global", paths: [path.join(lagoon, "identity.md")], message: "sync" });
  assert.equal(sync.reason, "git_operation_in_progress");
  assert.deepEqual(sync.conflictingPaths, ["identity.md"]);
  await assert.rejects(
    memory.writeMemoryFile({ scope: "global", path: "identity.md", content: "Replacement" }),
    /unfinished Git operation/,
  );
  const wakeUp = await memory.wakeUp({ projectRoot: lagoon, checkUpdate: async () => null });
  assert.equal(wakeUp.pull.reason, "git_operation_in_progress");
  assert.ok(wakeUp.missing.includes("global:identity.md"));
  assert.doesNotMatch(wakeUp.text, /<<<<<<</);
  assert.equal(git(["status", "--porcelain"]), before);
});

async function appendInParallel(tempRoot, titles) {
  const run = promisify(execFile);
  const worker = `
    const memory = require(process.argv[1]);
    const title = process.argv[2];
    memory.appendEvent({ scope: "global", title, content: title, date: "2026-11-24" })
      .then((result) => console.log(JSON.stringify(result.sync)))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  `;
  const modulePath = require.resolve("../scripts/hippocamp-memory.cjs");
  const results = await Promise.allSettled(titles.map(async (title) => {
    const tmp = await fs.mkdtemp(path.join(tempRoot, "worker-"));
    return run(process.execPath, ["-e", worker, modulePath, title], {
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
  }));
  return results.map((result) => {
    assert.equal(result.status, "fulfilled", result.reason?.stderr);
    return JSON.parse(result.value.stdout);
  });
}

test("parallel processes push every event and its index", async (t) => {
  const { git, lagoon, remote } = await createSyncClones(t);
  const titles = Array.from({ length: 8 }, (_, i) => `Checkpoint ${i}`);
  for (const sync of await appendInParallel(path.dirname(lagoon), titles)) {
    assert.equal(sync.committed, true, JSON.stringify(sync));
    assert.equal(sync.pushed, true, JSON.stringify(sync));
  }

  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(git(["rev-parse", "HEAD"]), git(["rev-parse", "main"], remote));
  const index = JSON.parse(await fs.readFile(path.join(lagoon, "events", "2026-11-24.index.json"), "utf8"));
  assert.deepEqual(index.events.map((event) => event.heading).sort(), titles);
  const eventLog = git(["show", "main:events/2026-11-24.md"], remote);
  for (const title of titles) assert.match(eventLog, new RegExp(title));
});

test("non-Git Lagoon appends share a lock across different temp directories", async (t) => {
  withGitIdentity(t);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-no-git-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 }));
  const lagoon = path.join(tempRoot, "lagoon");
  process.env.HIPPOCAMP_GLOBAL_ROOT = lagoon;
  const titles = Array.from({ length: 8 }, (_, i) => `Checkpoint ${i}`);

  for (const sync of await appendInParallel(tempRoot, titles)) {
    assert.equal(sync.reason, "not_git_repo");
  }

  const index = JSON.parse(await fs.readFile(path.join(lagoon, "events", "2026-11-24.index.json"), "utf8"));
  assert.deepEqual(index.events.map((event) => event.heading).sort(), titles);
});

test("wake_up pulls memory another machine pushed", async (t) => {
  withGitIdentity(t);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-pull-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 }));
  const remote = path.join(tempRoot, "remote.git");
  const lagoon = path.join(tempRoot, "lagoon");
  const other = path.join(tempRoot, "other-machine");
  const git = (args, cwd) => execFileSync("git", args, { cwd }).toString().trim();

  git(["init", "-q", "--bare", "-b", "main", remote], tempRoot);
  git(["clone", "-q", remote, lagoon], tempRoot);
  git(["commit", "-q", "--allow-empty", "-m", "init"], lagoon);
  git(["push", "-q", "-u", "origin", "main"], lagoon);
  git(["clone", "-q", remote, other], tempRoot);
  await fs.writeFile(path.join(other, "identity.md"), "# Identity\n\n- Written on the other machine.\n");
  git(["add", "identity.md"], other);
  git(["commit", "-q", "-m", "other machine"], other);
  git(["push", "-q"], other);

  process.env.HIPPOCAMP_GLOBAL_ROOT = lagoon;
  const result = await memory.wakeUp({ projectRoot: path.join(tempRoot, "project") });

  assert.match(JSON.stringify(result), /Written on the other machine/);
});

test("sync never commits into a repository that only encloses the Lagoon", async (t) => {
  withGitIdentity(t);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-enclosed-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 }));
  const outer = path.join(tempRoot, "code-repo");
  const git = (args, cwd = outer) => execFileSync("git", args, { cwd }).toString().trim();

  await fs.mkdir(outer, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "code"]);
  const before = git(["rev-parse", "HEAD"]);

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(outer, "memory");
  const write = await memory.appendEvent({ content: "Secret plan.", keywords: ["plan"], projectRoot: path.join(tempRoot, "project"), scope: "project", title: "Plan" });

  assert.equal(write.sync.committed, undefined);
  assert.equal(write.sync.reason, "lagoon_not_repo_root");
  assert.equal(git(["rev-parse", "HEAD"]), before);
});
