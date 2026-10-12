const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");
const memory = require("../scripts/hippocamp-memory.cjs");

const exec = promisify(execFile);

test("Dream runner publishes first summaries and skips an unchanged repeat", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-runner-test-"));
  const seed = path.join(root, "seed");
  const remote = path.join(root, "remote.git");
  const bin = path.join(root, "bin");
  const calls = path.join(root, "prs");
  const preload = path.join(root, "model.cjs");
  const previousRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    else process.env.HIPPOCAMP_GLOBAL_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(seed);
  await fs.mkdir(bin);
  process.env.HIPPOCAMP_GLOBAL_ROOT = seed;
  await memory.appendEvent({ projectRoot: "/tmp/new-project", scope: "project", sync: false, title: "Confirmed decision", keywords: ["constraint"], content: "Keep production access read-only." });
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_TOKEN: "fixture",
    LAGOON_REPOSITORY: "fixture/lagoon",
    MANIFEST_API_KEY: "fixture",
    MANIFEST_BASE_URL: "https://model.invalid",
    HIPPOCAMP_DREAM_AUTO_MERGE: "false",
    NODE_OPTIONS: `--require=${preload}`,
    FIXTURE_REMOTE: remote,
    FIXTURE_CALLS: calls,
  };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, "[user]\nname = Fixture\nemail = fixture@localhost\n");
  await fs.writeFile(preload, `
    global.fetch = async () => {
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(path.join(process.env.HIPPOCAMP_GLOBAL_ROOT, "unrelated.md"), "Do not publish this file");
      return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: JSON.stringify({
        current_state_md: "# Current State\\n\\n- Keep production access read-only.",
        open_threads_md: "# Open Threads\\n\\n- Verify deployment."
      }) }) };
    };
  `);
  await fs.writeFile(path.join(bin, "gh"), `#!${process.execPath}
    const fs = require("node:fs");
    const { execFileSync } = require("node:child_process");
    const args = process.argv.slice(2);
    if (args[0] === "auth") process.exit(0);
    if (args[0] === "repo" && args[1] === "clone") {
      execFileSync("git", ["clone", process.env.FIXTURE_REMOTE, args[3]], { stdio: "inherit" });
    } else if (args[0] === "pr" && args[1] === "list") {
      if (fs.existsSync(process.env.FIXTURE_CALLS)) console.log("1");
    } else if (args[0] === "pr" && args[1] === "create") {
      fs.appendFileSync(process.env.FIXTURE_CALLS, "created\\n");
    } else {
      throw new Error("Unexpected gh operation: " + args.join(" "));
    }
  `, { mode: 0o755 });
  const git = (args, cwd = seed) => exec("git", args, { cwd, env });
  await git(["init", "-b", "main"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Seed indexed evidence without curated files"]);
  const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["clone", "--bare", seed, remote]);
  const runner = path.resolve(__dirname, "../assets/railway/run-dream.sh");
  await exec("bash", [runner], { env });
  const changed = (await git(["diff", "--name-only", before, "refs/heads/dream/new-project"], remote)).stdout.trim().split("\n");
  assert.deepEqual(changed, ["projects/new-project/current_state.md", "projects/new-project/open_threads.md"]);
  assert.match((await git(["show", "dream/new-project:projects/new-project/current_state.md"], remote)).stdout, /hippocamp-dream-through:/);
  assert.equal(await fs.readFile(calls, "utf8"), "created\n");
  // Simulate accepting the reviewed PR, then repeat against the same evidence.
  await git(["update-ref", "refs/heads/main", "refs/heads/dream/new-project"], remote);
  await exec("bash", [runner], { env });
  assert.equal(await fs.readFile(calls, "utf8"), "created\n");
});
