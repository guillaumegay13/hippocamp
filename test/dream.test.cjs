const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dream = require("../scripts/hippocamp-dream.cjs");
const memory = require("../scripts/hippocamp-memory.cjs");

async function fixture(t) {
  const previousRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const previousFetch = global.fetch;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-dream-test-"));
  process.env.HIPPOCAMP_GLOBAL_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    else process.env.HIPPOCAMP_GLOBAL_ROOT = previousRoot;
    global.fetch = previousFetch;
    await fs.rm(root, { recursive: true, force: true });
  });
  const slug = "dream-fixture";
  const projectRoot = `/tmp/${slug}`;
  const project = path.join(root, "projects", slug);
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "current_state.md"), "# Current State\n\n- Keep production reads fail-closed.\n");
  await fs.writeFile(path.join(project, "open_threads.md"), "# Open Threads\n\n- Merge PR #2928, then verify deployment.\n- Investigate the unresolved native Google blocker.\n");
  const options = { thresholdChars: 20000, targetChars: 3000, write: true, apiKey: "test", baseUrl: "https://model.test", model: "test" };
  async function event(title, content, offset = -60000) {
    const timestamp = new Date(Date.now() + offset).toISOString();
    await memory.appendEvent({ projectRoot, scope: "project", sync: false, title, content, keywords: ["dream-test"], timestamp, date: timestamp.slice(0, 10) });
    return timestamp;
  }
  return { root, slug, projectRoot, project, options, event };
}

function respond(output) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: JSON.stringify(output) }) };
}

test("small projects receive new evidence and may grow; a successful batch is not reviewed twice", async (t) => {
  const f = await fixture(t);
  const id = await f.event("PR #2928 merged and a reusable lesson", "PR #2928 merged. Deployment has not been verified.\n\nDecision: project identity follows the canonical repository, because worktree names are temporary.");
  const eventPath = path.join(f.project, "events", `${id.slice(0, 10)}.md`);
  const originalEvents = await fs.readFile(eventPath, "utf8");
  let calls = 0;
  global.fetch = async (_url, request) => {
    calls++;
    const input = JSON.parse(request.body).input;
    assert.match(input, /Recent Event Evidence/);
    assert.ok(input.includes(id));
    assert.match(input, /PR #2928 merged\. Deployment has not been verified/);
    assert.match(input, /canonical repository/);
    assert.match(input, /unresolved native Google blocker/);
    assert.match(input, /A merged PR closes the merge action, not unverified deployment/);
    return respond({
      current_state_md: `# Current State\n\n- Keep production reads fail-closed.\n- Project identity follows the canonical repository because worktree names are temporary. Source: events/${id.slice(0, 10)}.md, ${id}.`,
      open_threads_md: "# Open Threads\n\n- Verify PR #2928 deployment.\n- Investigate the unresolved native Google blocker.",
    });
  };
  const scan = await dream.dreamProject(f.slug, { ...f.options, write: false });
  assert.equal(scan.skipped, "dry_run");
  assert.equal(calls, 0);
  const result = await dream.dreamProject(f.slug, f.options);
  assert.ok(result.afterBytes > result.beforeBytes);
  assert.ok(result.afterBytes <= f.options.targetChars * 1.02);
  assert.equal(result.recentEvidence.items.length, 1);
  assert.equal(dream.toPublicReport(result).context.recentEvents, 1);
  assert.ok((await fs.readFile(path.join(f.project, "current_state.md"), "utf8")).includes(`hippocamp-dream-through: ${id}`));
  assert.equal(await fs.readFile(eventPath, "utf8"), originalEvents);
  assert.equal((await dream.dreamProject(f.slug, f.options)).skipped, "below_threshold");
  assert.equal(calls, 1);
});

test("bootstrap ignores old, future, and unindexed events; a recorded cursor survives downtime", async (t) => {
  const f = await fixture(t);
  const old = await f.event("Old event", "An older durable constraint.", -10 * 86400000);
  await f.event("Future event", "Not yet evidence.", 86400000);
  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(path.join(f.project, "events", `${today}.md`), `## ${new Date().toISOString()} — Unindexed\n\nDo not ingest.\n`);
  assert.equal((await dream.dreamProject(f.slug, { ...f.options, write: false })).skipped, "below_threshold");
  const marker = new Date(Date.now() - 11 * 86400000).toISOString();
  await fs.appendFile(path.join(f.project, "current_state.md"), `\n<!-- hippocamp-dream-through: ${marker} -->\n`);
  const resumed = await dream.dreamProject(f.slug, { ...f.options, write: false });
  assert.equal(resumed.skipped, "dry_run");
  assert.deepEqual(resumed.recentEvidence.items.map((e) => e.id), [old]);
});

test("Dream preserves existing curated-file permissions when replacing the snapshot", async (t) => {
  const f = await fixture(t);
  await f.event("Durable correction", "Keep production reads fail-closed.");
  const currentPath = path.join(f.project, "current_state.md");
  const threadsPath = path.join(f.project, "open_threads.md");
  await fs.chmod(currentPath, 0o600);
  await fs.chmod(threadsPath, 0o640);
  global.fetch = async () => respond({ current_state_md: "# Current State\n\n- Keep production reads fail-closed.", open_threads_md: "# Open Threads\n\n- Keep unresolved work." });
  await dream.dreamProject(f.slug, f.options);
  assert.equal((await fs.stat(currentPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(threadsPath)).mode & 0o777, 0o640);
});

test("bounded batches defer remaining events without advancing past unseen evidence", async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await f.event(`Lesson ${i}`, `Constraint ${i}: ${"Keep the documented boundary. ".repeat(18)}`, -60000 + i * 1000));
  global.fetch = async () => respond({ current_state_md: "# Current State\n\n- Keep the documented boundary.", open_threads_md: "# Open Threads\n\n- Investigate the unresolved native Google blocker." });
  const first = await dream.dreamProject(f.slug, f.options);
  assert.ok(first.recentEvidence.items.length > 0 && first.recentEvidence.items.length < ids.length);
  assert.equal(first.recentEvidence.reviewedThrough, first.recentEvidence.items.at(-1).id);
  const second = await dream.dreamProject(f.slug, { ...f.options, write: false });
  assert.equal(second.recentEvidence.items[0].id, ids[first.recentEvidence.items.length]);
  const report = dream.toPublicReport(first);
  assert.ok(report.context.evidenceChars <= report.context.evidenceBudgetChars);
});

test("an oversized model result fails without changing files or the event cursor", async (t) => {
  const f = await fixture(t);
  await f.event("Durable correction", "Keep production reads fail-closed.");
  const paths = ["current_state.md", "open_threads.md"].map((name) => path.join(f.project, name));
  const before = await Promise.all(paths.map((name) => fs.readFile(name, "utf8")));
  global.fetch = async () => respond({ current_state_md: `# Current State\n\n- ${"Too large. ".repeat(400)}`, open_threads_md: "# Open Threads\n\n- Keep unresolved work." });
  await assert.rejects(dream.dreamProject(f.slug, f.options), /did not reduce the snapshot/);
  assert.deepEqual(await Promise.all(paths.map((name) => fs.readFile(name, "utf8"))), before);
});

test("an oversized first excerpt fails before a model call without skipping evidence", async (t) => {
  const f = await fixture(t);
  await f.event("Durable correction", "Keep production reads fail-closed.");
  const paths = ["current_state.md", "open_threads.md"].map((name) => path.join(f.project, name));
  const before = await Promise.all(paths.map((name) => fs.readFile(name, "utf8")));
  global.fetch = async () => assert.fail("Model must not be called");
  await assert.rejects(dream.dreamProject(f.slug, { ...f.options, targetChars: 100 }), /Recent event evidence does not fit/);
  assert.deepEqual(await Promise.all(paths.map((name) => fs.readFile(name, "utf8"))), before);
});

test("compaction retries retain source evidence while the caller owns the review marker", async (t) => {
  const f = await fixture(t);
  const id = await f.event("Durable correction", "Keep production reads fail-closed.");
  const source = `events/${id.slice(0, 10)}.md, ${id}`;
  let calls = 0;
  global.fetch = async (_url, request) => {
    const input = JSON.parse(request.body).input;
    calls++;
    if (calls === 1) return respond({ current_state_md: `# Current State\n\n- Keep production reads fail-closed. Source: ${source}.\n\n- ${"Historical detail. ".repeat(200)}`, open_threads_md: "# Open Threads\n\n- Keep unresolved work." });
    assert.ok(input.includes(source));
    assert.match(input, /Preserve the event path and timestamp attached to each retained/);
    assert.doesNotMatch(input, /<!-- hippocamp-dream-through:/);
    const retryTarget = Number(input.match(/Target combined size[^:]*: (\d+) chars/)[1]);
    assert.ok(retryTarget > 0 && retryTarget < f.options.targetChars);
    return respond({ current_state_md: `# Current State\n\n- Keep production reads fail-closed. Source: ${source}.`, open_threads_md: "# Open Threads\n\n- Keep unresolved work." });
  };
  const result = await dream.dreamProject(f.slug, f.options);
  assert.equal(result.compactionPasses, 2);
  const current = await fs.readFile(path.join(f.project, "current_state.md"), "utf8");
  assert.ok(current.includes(source));
  assert.equal((current.match(/<!-- hippocamp-dream-through:/g) || []).length, 1);
  assert.equal((await dream.dreamProject(f.slug, f.options)).skipped, "below_threshold");
  assert.equal(calls, 2);
});

test("recent reads ignore an index path that points outside its canonical event day", async (t) => {
  const f = await fixture(t);
  const id = await f.event("Safe event", "Canonical event evidence.");
  const indexPath = path.join(f.project, "events", `${id.slice(0, 10)}.index.json`);
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  index.path = "../../outside.md";
  await fs.writeFile(path.join(f.root, "outside.md"), `## ${id} — Other\n\nOutside scope.\n`);
  await fs.writeFile(indexPath, JSON.stringify(index));
  const events = await memory.readRecentEvents({ projectRoot: f.projectRoot, after: new Date(Date.now() - 86400000).toISOString() });
  assert.equal(events.length, 1);
  assert.match(events[0].snippet, /Canonical event evidence/);
  assert.doesNotMatch(events[0].snippet, /Outside scope/);
});

for (const failure of ["current_state.md", "open_threads.md", "commit"]) {
  test(`a failed ${failure} save leaves both files and the review marker unchanged`, async (t) => {
    const f = await fixture(t);
    await f.event("Durable correction", "Keep production reads fail-closed.");
    const paths = ["current_state.md", "open_threads.md"].map((name) => path.join(f.project, name));
    const before = await Promise.all(paths.map((name) => fs.readFile(name, "utf8")));
    global.fetch = async () => respond({ current_state_md: "# Current State\n\n- Keep production reads fail-closed.", open_threads_md: "# Open Threads\n\n- Keep unresolved work." });
    const method = failure === "commit" ? "rename" : "writeFile";
    const original = fs[method];
    t.mock.method(fs, method, async (file, ...args) => {
      if (failure === "commit" ? args[0] === paths[0] : path.basename(file) === failure) throw new Error("Fixture write failure");
      return original(file, ...args);
    });
    await assert.rejects(dream.dreamProject(f.slug, f.options), /Fixture write failure/);
    assert.deepEqual(await Promise.all(paths.map((name) => fs.readFile(name, "utf8"))), before);
    assert.equal((await fs.readdir(f.project)).some((name) => name.startsWith(".dream-")), false);
  });
}
