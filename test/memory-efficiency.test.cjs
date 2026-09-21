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
