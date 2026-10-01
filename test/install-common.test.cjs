const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { mcpServerCommand, prepareLagoon } = require("../scripts/install-common.cjs");

// CI runners have no Git identity; commits in these tests need one.
const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function tempDir(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hippocamp-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

test("mcpServerCommand pins npx installs and keeps source checkouts direct", async (t) => {
  const root = await tempDir(t, "npx");
  const npxRoot = path.join(root, "_npx", "abc", "node_modules", "hippocamp");
  await fs.mkdir(npxRoot, { recursive: true });
  await fs.writeFile(path.join(npxRoot, "package.json"), '{ "version": "9.9.9" }');

  assert.deepEqual(mcpServerCommand(npxRoot).slice(1), ["-y", "--prefer-offline", "hippocamp@9.9.9", "mcp"]);
  assert.deepEqual(mcpServerCommand("/src/hippocamp"), [process.execPath, "/src/hippocamp/scripts/hippocamp-mcp.cjs"]);
});

test("prepareLagoon creates a missing Lagoon repo and says it is local only", async (t) => {
  Object.assign(process.env, gitEnv);
  const lagoon = path.join(await tempDir(t, "lagoon"), "lagoon");
  const result = await prepareLagoon(lagoon);

  assert.equal(result.created, true);
  assert.equal(result.push, "no_remote");
  assert.match(result.hints.join("\n"), /gh repo create lagoon --private/);
  assert.equal(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: lagoon }).toString().trim(), "true");
});

test("prepareLagoon leaves a non-empty folder that is not a repo alone", async (t) => {
  const folder = await tempDir(t, "notes");
  await fs.writeFile(path.join(folder, "notes.md"), "mine\n");
  const result = await prepareLagoon(folder);

  assert.equal(result.push, "not_git");
  await assert.rejects(fs.stat(path.join(folder, ".git")));
});

test("prepareLagoon checks push to an existing remote", async (t) => {
  Object.assign(process.env, gitEnv);
  const root = await tempDir(t, "remote");
  const remote = path.join(root, "remote.git");
  const lagoon = path.join(root, "lagoon");
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-b", "main", lagoon]);
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: lagoon });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: lagoon });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: lagoon, stdio: "ignore" });

  const result = await prepareLagoon(lagoon);

  assert.equal(result.created, false);
  assert.equal(result.remote, remote);
  assert.equal(result.push, "ok");
});

test("prepareLagoon refuses a folder inside another repo", async (t) => {
  Object.assign(process.env, gitEnv);
  const parent = await tempDir(t, "parent");
  execFileSync("git", ["init", "-b", "main", parent]);
  const nested = path.join(parent, "notes");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "a.md"), "x\n");

  const result = await prepareLagoon(nested);

  assert.equal(result.push, "not_git");
  await assert.rejects(fs.stat(path.join(nested, ".git")));
});

test("prepareLagoon gives an empty folder inside another repo its own repo", async (t) => {
  Object.assign(process.env, gitEnv);
  const parent = await tempDir(t, "parent-empty");
  execFileSync("git", ["init", "-b", "main", parent]);
  const nested = path.join(parent, "lagoon");

  const result = await prepareLagoon(nested);

  assert.equal(result.created, true);
  assert.equal(fsSync.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: nested }).toString().trim()), fsSync.realpathSync(nested));
});
