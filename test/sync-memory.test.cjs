const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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
