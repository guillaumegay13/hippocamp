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

// Scoped to each test that needs a Git identity, then restored.
function useGitIdentity(t) {
  const saved = Object.fromEntries(Object.keys(gitEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, gitEnv);
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

async function tempDir(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hippocamp-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

test("mcpServerCommand copies npx installs to a stable folder and keeps source checkouts direct", async (t) => {
  const root = await tempDir(t, "npx");
  const modules = path.join(root, "_npx", "abc", "node_modules");
  const npxRoot = path.join(modules, "hippocamp");
  const home = path.join(root, "home");
  await fs.mkdir(path.join(npxRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(modules, "minisearch"), { recursive: true });
  await fs.writeFile(path.join(npxRoot, "package.json"), '{ "version": "9.9.9" }');
  await fs.writeFile(path.join(npxRoot, "scripts", "hippocamp-mcp.cjs"), "// server\n");
  await fs.writeFile(path.join(modules, "minisearch", "index.js"), "// dependency\n");

  const command = mcpServerCommand(npxRoot, home);
  const stable = path.join(home, ".hippocamp", "9.9.9", "node_modules");

  assert.deepEqual(command, [process.execPath, path.join(stable, "hippocamp", "scripts", "hippocamp-mcp.cjs")]);
  await fs.stat(command[1]);
  await fs.stat(path.join(stable, "minisearch", "index.js"));

  // A reinstall of the same version replaces the copy: no stale files, no staging left behind.
  await fs.writeFile(path.join(stable, "stale.js"), "// old\n");
  mcpServerCommand(npxRoot, home);
  await assert.rejects(fs.stat(path.join(stable, "stale.js")));
  assert.deepEqual(await fs.readdir(path.join(home, ".hippocamp", "9.9.9")), ["node_modules"]);

  const source = path.join(root, "src", "hippocamp");
  assert.deepEqual(mcpServerCommand(source), [process.execPath, path.join(source, "scripts", "hippocamp-mcp.cjs")]);
});

test("prepareLagoon creates a missing Lagoon repo and says it is local only", async (t) => {
  useGitIdentity(t);
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
  useGitIdentity(t);
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
  useGitIdentity(t);
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
  useGitIdentity(t);
  const parent = await tempDir(t, "parent-empty");
  execFileSync("git", ["init", "-b", "main", parent]);
  const nested = path.join(parent, "lagoon");

  const result = await prepareLagoon(nested);

  assert.equal(result.created, true);
  assert.equal(fsSync.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: nested }).toString().trim()), fsSync.realpathSync(nested));
});

test("prepareLagoon links older event keywords once and commits them locally", async (t) => {
  useGitIdentity(t);
  const lagoon = path.join(await tempDir(t, "link-keywords"), "lagoon");
  const eventPath = path.join(lagoon, "projects", "demo", "events", "2026-05-01.md");
  const notePath = path.join(lagoon, "projects", "demo", "notes.md");
  const oldEvent = [
    "# 2026-05-01",
    "",
    "## 09:00 - Inline cues",
    "Cues: Mem0 removal, bare MCP",
    "",
    "## 10:00 - Bullet cues",
    "Shipped it.",
    "",
    "Cues:",
    "- pr-12",
    "- [[already-linked]]",
    "- `npm test` passed",
    "",
    "- a content bullet",
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(eventPath), { recursive: true });
  await fs.writeFile(eventPath, oldEvent);
  await fs.writeFile(notePath, "Cues: left, alone\n");
  execFileSync("git", ["init", "-b", "main", lagoon]);
  execFileSync("git", ["add", "."], { cwd: lagoon });
  execFileSync("git", ["commit", "-m", "init"], { cwd: lagoon });

  const first = await prepareLagoon(lagoon);
  const linked = await fs.readFile(eventPath, "utf8");

  assert.equal(first.linkedEvents, 1);
  assert.match(linked, /## 09:00 - Inline cues\nKeywords:\n- \[\[mem0-removal\]\]\n- \[\[bare-mcp\]\]\n/);
  assert.match(linked, /Keywords:\n- \[\[pr-12\]\]\n- \[\[already-linked\]\]\n- `npm test` passed\n\n- a content bullet\n/);
  assert.equal(await fs.readFile(notePath, "utf8"), "Cues: left, alone\n");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: lagoon, encoding: "utf8" }), "");
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: lagoon, encoding: "utf8" }).trim(), "hippocamp: link event keywords");

  const second = await prepareLagoon(lagoon);

  assert.equal(second.linkedEvents, 0);
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: lagoon, encoding: "utf8" }).trim(), "2");
});

test("prepareLagoon leaves dirty event files alone and links CRLF events without duplicates", async (t) => {
  useGitIdentity(t);
  const lagoon = path.join(await tempDir(t, "link-dirty"), "lagoon");
  const events = path.join(lagoon, "events");
  const crlfPath = path.join(events, "2026-05-01.md");
  const dirtyPath = path.join(events, "2026-05-02.md");
  const untrackedPath = path.join(events, "2026-05-03.md");

  await fs.mkdir(events, { recursive: true });
  await fs.writeFile(crlfPath, "# 2026-05-01\r\n\r\n## 09:00 - CRLF\r\nCues: bare MCP, Bare MCP\r\n");
  await fs.writeFile(dirtyPath, "## 09:00 - Dirty\nCues:\n- pr-1\n");
  execFileSync("git", ["init", "-b", "main", lagoon]);
  execFileSync("git", ["add", "."], { cwd: lagoon });
  execFileSync("git", ["commit", "-m", "init"], { cwd: lagoon });
  await fs.appendFile(dirtyPath, "- user-edit\n");
  await fs.writeFile(untrackedPath, "## 09:00 - Untracked\nCues:\n- pr-2\n");

  const result = await prepareLagoon(lagoon);

  assert.equal(result.linkedEvents, 1);
  assert.equal(await fs.readFile(crlfPath, "utf8"), "# 2026-05-01\r\n\r\n## 09:00 - CRLF\r\nKeywords:\r\n- [[bare-mcp]]\r\n");
  assert.equal(await fs.readFile(dirtyPath, "utf8"), "## 09:00 - Dirty\nCues:\n- pr-1\n- user-edit\n");
  assert.equal(await fs.readFile(untrackedPath, "utf8"), "## 09:00 - Untracked\nCues:\n- pr-2\n");
  assert.equal(execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: lagoon, encoding: "utf8" }).trim(), "events/2026-05-01.md");
});

test("prepareLagoon undoes linked keywords when Git cannot commit them", async (t) => {
  useGitIdentity(t);
  const lagoon = path.join(await tempDir(t, "link-no-commit"), "lagoon");
  const eventPath = path.join(lagoon, "events", "2026-05-01.md");
  const oldEvent = "## 09:00 - Old\nCues:\n- pr-1\n";

  await fs.mkdir(path.dirname(eventPath), { recursive: true });
  await fs.writeFile(eventPath, oldEvent);
  execFileSync("git", ["init", "-b", "main", lagoon]);
  execFileSync("git", ["add", "."], { cwd: lagoon });
  execFileSync("git", ["commit", "-m", "init"], { cwd: lagoon });
  const hook = path.join(lagoon, ".git", "hooks", "pre-commit");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n");
  await fs.chmod(hook, 0o755);

  const result = await prepareLagoon(lagoon);

  assert.equal(result.linkedEvents, 0);
  assert.equal(await fs.readFile(eventPath, "utf8"), oldEvent);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: lagoon, encoding: "utf8" }), "");
  assert.ok(result.hints.some((hint) => /could not commit/.test(hint)));
});
