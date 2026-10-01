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
  await fs.mkdir(projectRoot);
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
    cues: ["locks"],
    projectRoot,
    scope: "project",
    title: "Queue decision",
  });

  assert.equal(result.sync.committed, true);
  assert.match(git(["log", "--format=%s", "-1"]), /append project event/);
});
