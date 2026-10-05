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
    keywords: ["strict-index"],
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
    keywords: ["oversized-metadata"],
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
    "# Events: 2026-09-20\n\n## 09:00 — Hidden fallback\n\nKeywords:\n- quasar-velvet\n\nShould not be scanned.\n",
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

  for (const [title, keywords, content] of [
    ["Deploy note", ["deploy"], "The zanzibar migration needs a rollback plan."],
    ["Unrelated note", ["billing"], "Invoices are generated monthly."],
  ]) {
    await memory.appendEvent({ content, keywords, projectRoot, scope: "project", sync: false, title });
  }

  const search = await memory.searchMemory({ projectRoot, query: "zanzibr rollback", scope: "project" });

  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].heading, "Deploy note");
  assert.equal(search.results[0].match, "body");
});

test("search still matches events written with legacy Cues sections and indexes", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-legacy-cues-"));
  const projectRoot = path.join(tempRoot, "legacy-project");
  const eventsRoot = path.join(tempRoot, "lagoon", "projects", "legacy-project", "events");

  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(tempRoot, "lagoon");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(eventsRoot, { recursive: true });
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const id = "2026-09-01T09:00:00.000Z";
  await fs.writeFile(
    path.join(eventsRoot, "2026-09-01.md"),
    `# Events — 2026-09-01\n\n## ${id} — Old note\n\nCues:\n- quasar-velvet\n\nOld body.\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(eventsRoot, "2026-09-01.index.json"),
    JSON.stringify({ version: 1, path: "2026-09-01.md", events: [{ id, heading: "Old note", cues: ["quasar-velvet"] }] }),
    "utf8",
  );

  const search = await memory.searchMemory({ projectRoot, query: "quasar velvet", scope: "project" });

  assert.equal(search.results.length, 1);
  assert.deepEqual(search.results[0].keywords, ["quasar-velvet"]);
  assert.equal(search.results[0].match, "keywords");
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
    keywords: ["infra"],
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
    keywords: ["infra"],
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
    keywords: ["deploy"],
    projectRoot,
    scope: "project",
    sync: false,
    timestamp,
    title: "Deploy note",
  });
  const second = await memory.appendEvent({
    content: "Invoices are generated monthly.",
    keywords: ["billing"],
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
        keywords: ["parallel"],
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

test("search favors events from a month named in the query", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-month-search-"));
  const projectRoot = path.join(tempRoot, "month-project");

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

  for (const timestamp of ["2026-05-02T08:00:00.000Z", "2026-08-05T10:00:00.000Z", "2026-09-01T09:00:00.000Z"]) {
    await memory.appendEvent({
      content: "Published the Android build to Google Play production.",
      keywords: ["android-release"],
      date: timestamp.slice(0, 10),
      projectRoot,
      scope: "project",
      sync: false,
      timestamp,
      title: "Android release",
    });
  }

  const byMonth = await memory.searchMemory({ projectRoot, query: "android build in august", scope: "project" });
  const byDay = await memory.searchMemory({ projectRoot, query: "android build 2026-05-02", scope: "project" });

  assert.equal(byMonth.results[0].id, "2026-08-05T10:00:00.000Z");
  assert.equal(byDay.results[0].id, "2026-05-02T08:00:00.000Z");
});

test("search favors events from a relative date named in the query", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-relative-date-"));
  const projectRoot = path.join(tempRoot, "relative-project");

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

  // Seven days ago is always in last calendar week; one day ago is yesterday.
  const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const timestamps = { yesterday: daysAgo(1), lastWeek: daysAgo(7), older: daysAgo(30) };

  for (const [key, timestamp] of Object.entries(timestamps)) {
    await memory.appendEvent({
      // The old event matches the words better, so only the date words can rank the others first.
      content: key === "older" ? "Deploy key rotation: rotated the deploy key again." : "Rotated the key for staging.",
      keywords: ["deploy-key"],
      date: timestamp.slice(0, 10),
      projectRoot,
      scope: "project",
      sync: false,
      timestamp,
      title: "Deploy key rotation",
    });
  }

  const ids = async (phrase) =>
    (await memory.searchMemory({ projectRoot, query: `deploy key rotation ${phrase}`, scope: "project" })).results.map(
      (result) => result.id,
    );

  assert.deepEqual(await ids("yesterday"), [timestamps.yesterday]);
  // On a Monday, yesterday is also in last week.
  const lastWeek = await ids("last week");
  assert.ok(lastWeek.includes(timestamps.lastWeek));
  assert.ok(!lastWeek.includes(timestamps.older));
  assert.deepEqual(await ids("today"), []);
});

test("search returns a snippet for a long event matched only by its date", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-date-only-"));
  const projectRoot = path.join(tempRoot, "date-only-project");

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

  await memory.appendEvent({
    content: Array(30).fill("The weekly sync covered routine updates.").join("\n\n"),
    keywords: ["sync"],
    date: "2026-08-05",
    projectRoot,
    scope: "project",
    sync: false,
    timestamp: "2026-08-05T10:00:00.000Z",
    title: "Weekly sync",
  });

  const search = await memory.searchMemory({ projectRoot, query: "2026-08-05", scope: "project" });

  assert.equal(search.results.length, 1);
  assert.match(search.results[0].snippet, /^The weekly sync covered routine updates\./);
  assert.ok(search.results[0].snippet.length <= 1200);
});

test("search returns nothing when no memory is about the question", async (t) => {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-unrelated-"));
  const projectRoot = path.join(tempRoot, "unrelated-project");

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

  for (const [title, content] of [
    ["Backend deploy", "The backend deploys to Cloud Run after the build passes."],
    ["Deploy rollback", "A failed backend deploy rolls back to the previous revision."],
    ["Billing note", "Invoices are generated monthly."],
  ]) {
    await memory.appendEvent({ content, keywords: ["ops"], projectRoot, scope: "project", sync: false, title });
  }

  const unrelated = await memory.searchMemory({ projectRoot, query: "which kubernetes namespace does the backend deploy to", scope: "project" });
  const related = await memory.searchMemory({ projectRoot, query: "where does the backend deploy", scope: "project" });

  const monthOnly = await memory.searchMemory({ projectRoot, query: "deploy in august", scope: "project" });

  assert.deepEqual(unrelated.results, []);
  assert.equal(related.results[0].heading, "Backend deploy");
  // No event is from August; the month name must not count as a missing topic word.
  assert.ok(monthOnly.results.length > 0);
});
