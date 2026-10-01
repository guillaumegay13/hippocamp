const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dream = require("../scripts/hippocamp-dream.cjs");
const memory = require("../scripts/hippocamp-memory.cjs");

function modelResponse(output) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ output_text: JSON.stringify(output) });
    },
  };
}

test("Dream compacts an oversized result again without cropping", async (t) => {
  const originalFetch = global.fetch;
  const outputs = [
    {
      current_state_md: `# Current State\n\n- ${"a".repeat(140)}`,
      open_threads_md: "# Open Threads\n\n- Keep the active task.",
    },
    {
      current_state_md: "# Current State\n\n- Active.",
      open_threads_md: "# Open Threads\n\n- Continue.",
    },
  ];
  const requests = [];

  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return modelResponse(outputs.shift());
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await dream.compactDreamOutput({
    apiKey: "test-key",
    baseUrl: "https://manifest.test",
    beforeBytes: 500,
    model: "test-model",
    report: {
      slug: "test-project",
      wakeUpChars: 500,
      files: {
        "current_state.md": { content: `# Current State\n\n- ${"z".repeat(300)}` },
        "open_threads.md": { content: "# Open Threads\n\n- Keep the active task." },
      },
    },
    targetChars: 100,
    threadEvidence: {
      evidenceBudgetChars: 100,
      evidenceChars: 0,
      openThreadCount: 1,
      items: [],
    },
  });

  assert.equal(result.passes, 2);
  assert.equal(requests.length, 2);
  assert.ok(result.afterBytes <= 102);
  assert.match(requests[1].input, /previous compaction pass was still too large/i);
  assert.equal(result.output.currentState, "# Current State\n\n- Active.");
  assert.equal(result.output.openThreads, "# Open Threads\n\n- Continue.");
});

test("search uses indexed events and returns coherent evidence", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-search-"));
  const lagoonRoot = path.join(tempRoot, "lagoon");
  const projectRoot = path.join(tempRoot, "search-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = lagoonRoot;
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await memory.appendEvent({
    content: "Decision:\nUse indexed search only.",
    cues: ["strict-index"],
    date: "2026-09-21",
    projectRoot,
    scope: "project",
    sync: false,
    timestamp: "2026-09-21T10:00:00.000Z",
    title: "Strict indexed recall",
  });

  const indexed = await memory.searchMemory({
    projectRoot,
    query: "strict index",
    scope: "project",
  });

  assert.equal(indexed.results.length, 1);
  assert.match(indexed.results[0].snippet, /Use indexed search only\./);
  assert.doesNotMatch(indexed.results[0].snippet, /\.\.\./);

  await memory.appendEvent({
    content: `Decision:\n${"x".repeat(1300)}`,
    cues: ["oversized-metadata"],
    date: "2026-09-21",
    projectRoot,
    scope: "project",
    sync: false,
    timestamp: "2026-09-21T11:00:00.000Z",
    title: "Large metadata-only match",
  });

  const oversized = await memory.searchMemory({
    projectRoot,
    query: "oversized metadata",
    scope: "project",
  });

  assert.deepEqual(oversized.results, []);

  const projectMemoryRoot = path.join(lagoonRoot, "projects", "search-project");
  await fs.writeFile(
    path.join(projectMemoryRoot, "current_state.md"),
    "# Current State\n\n- Durable zebra setting is active.\n",
    "utf8",
  );

  const curated = await memory.searchMemory({
    projectRoot,
    query: "durable zebra",
    scope: "project",
  });

  assert.equal(curated.results[0].path, "current_state.md");
  assert.match(curated.results[0].snippet, /Durable zebra setting is active\./);

  const eventsRoot = path.join(projectMemoryRoot, "events");
  await fs.writeFile(
    path.join(eventsRoot, "2026-09-20.md"),
    "# Events: 2026-09-20\n\n## 09:00 — Hidden fallback\n\nCues:\n- quasar-velvet\n\nShould not be scanned.\n",
    "utf8",
  );

  const unindexed = await memory.searchMemory({
    projectRoot,
    query: "quasar velvet",
    scope: "project",
  });

  assert.deepEqual(unindexed.results, []);
});

test("search ranks indexed event bodies with typo tolerance", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-body-search-"));
  const projectRoot = path.join(tempRoot, "body-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(tempRoot, "lagoon");
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  for (const [title, cues, content] of [
    ["Deploy note", ["deploy"], "The zanzibar migration needs a rollback plan."],
    ["Unrelated note", ["billing"], "Invoices are generated monthly."],
  ]) {
    await memory.appendEvent({ content, cues, projectRoot, scope: "project", sync: false, title });
  }

  const search = await memory.searchMemory({ projectRoot, query: "zanzibr rollback", scope: "project" });

  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].heading, "Deploy note");
  assert.equal(search.results[0].match, "body");
});

test("search returns whole sentences from an oversized matching paragraph", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-long-paragraph-"));
  const projectRoot = path.join(tempRoot, "long-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(tempRoot, "lagoon");
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filler = "The weekly sync covered routine updates. ".repeat(40);
  await memory.appendEvent({
    content: `${filler}The kestrel database moved to eu-west-3. ${filler}`,
    cues: ["infra"],
    projectRoot,
    scope: "project",
    sync: false,
    title: "Weekly sync",
  });

  const search = await memory.searchMemory({ projectRoot, query: "kestrel database", scope: "project" });

  assert.equal(search.results.length, 1);
  assert.match(search.results[0].snippet, /The kestrel database moved to eu-west-3\./);
  assert.ok(search.results[0].snippet.length <= 1200);
  assert.match(search.results[0].snippet, /^The weekly sync|^The kestrel/);
});

test("search returns every matching paragraph that fits the excerpt budget", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-multi-paragraph-"));
  const projectRoot = path.join(tempRoot, "multi-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(tempRoot, "lagoon");
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const filler = "The weekly sync covered routine updates.";
  const paragraphs = [
    "The kestrel move started on Monday.",
    ...Array(30).fill(filler),
    "The kestrel database move finished in eu-west-3 on Friday.",
  ];
  await memory.appendEvent({
    content: paragraphs.join("\n\n"),
    cues: ["infra"],
    projectRoot,
    scope: "project",
    sync: false,
    title: "Weekly sync",
  });

  const search = await memory.searchMemory({ projectRoot, query: "kestrel database move", scope: "project" });
  const snippet = search.results[0].snippet;

  // The last paragraph matches more query words, so only the file-order sort puts it second.
  assert.ok(snippet.indexOf("started on Monday") < snippet.indexOf("finished in eu-west-3"));
  assert.match(snippet, /The kestrel move started on Monday\./);
  assert.match(snippet, /The kestrel database move finished in eu-west-3/);
  assert.ok(snippet.length <= 1200);
});

test("events appended in the same millisecond keep distinct ids and bodies", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-same-ms-"));
  const projectRoot = path.join(tempRoot, "same-ms-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(tempRoot, "lagoon");
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const timestamp = "2026-10-01T09:00:00.000Z";
  const first = await memory.appendEvent({
    content: "The zanzibar migration needs a rollback plan.",
    cues: ["deploy"],
    projectRoot,
    scope: "project",
    sync: false,
    timestamp,
    title: "Deploy note",
  });
  const second = await memory.appendEvent({
    content: "Invoices are generated monthly.",
    cues: ["billing"],
    projectRoot,
    scope: "project",
    sync: false,
    timestamp,
    title: "Billing note",
  });

  assert.equal(first.timestamp, timestamp);
  assert.equal(second.timestamp, "2026-10-01T09:00:00.001Z");

  const search = await memory.searchMemory({ projectRoot, query: "invoices monthly", scope: "project" });

  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].heading, "Billing note");
  assert.match(search.results[0].snippet, /Invoices are generated monthly\./);
});

test("parallel appends keep every event", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-parallel-append-"));
  const projectRoot = path.join(tempRoot, "parallel-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(tempRoot, "lagoon");
  await fs.mkdir(projectRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      memory.appendEvent({
        content: `Parallel event ${index}.`,
        cues: ["parallel"],
        date: "2026-10-01",
        projectRoot,
        scope: "project",
        sync: false,
        timestamp: "2026-10-01T09:00:00.000Z",
        title: `Event ${index}`,
      }),
    ),
  );
  const content = await fs.readFile(results[0].root + "/events/2026-10-01.md", "utf8");
  const ids = [...content.matchAll(/^## (\S+)/gm)].map((match) => match[1]);

  assert.equal(ids.length, 20);
  assert.equal(new Set(ids).size, 20);
  assert.equal(new Set(results.map((result) => result.timestamp)).size, 20);
});
