const test = require("node:test");
const assert = require("node:assert/strict");
const { HINT_PATTERN, factDistance, loadDataset, validateDataset } = require("../scripts/continuity-dataset.cjs");

// Two facts, the second replacing the first, and one probe checking the newest.
function tinyDataset() {
  const facts = [
    { id: "f1", project: "relay", kind: "decision", statement: "Queue in Redis.", plantedIn: "S1", supersededBy: "f2" },
    { id: "f2", project: "relay", kind: "decision", statement: "Queue in Postgres.", plantedIn: "S2", supersededBy: null },
  ];
  const sessions = new Map(
    [
      { id: "S1", project: "relay", kind: "work", turns: ["add a retry queue in redis"], plants: ["f1"], checklist: [] },
      { id: "S2", project: "relay", kind: "work", turns: ["move the queue to postgres"], plants: ["f2"], checklist: [] },
      {
        id: "P1",
        project: "relay",
        kind: "probe",
        turns: ["add retry metrics"],
        plants: [],
        checklist: [{ id: "P1-1", fact: "f2", check: "Metrics read from Postgres." }],
      },
    ].map((session) => [session.id, session]),
  );

  return { facts, sessions, timeline: ["S1", "S2", "P1"], seeds: {} };
}

test("valid dataset has no errors", () => {
  assert.deepEqual(validateDataset(tinyDataset()), []);
});

test("hint words are rejected", () => {
  const dataset = tinyDataset();
  dataset.sessions.get("P1").turns = ["check your notes and add retries"];
  const errors = validateDataset(dataset);

  assert.ok(errors.some((error) => error.includes("P1") && error.includes("hint")), errors.join("\n"));

  for (const phrase of ["remember", "recall", "memory", "your notes", "last session", "as we discussed", "previously"]) {
    assert.ok(HINT_PATTERN.test(`please ${phrase} this`), phrase);
  }

  assert.equal(HINT_PATTERN.test("add retries to delivery"), false);
});

test("probe cannot check a fact planted later", () => {
  const dataset = tinyDataset();
  dataset.timeline = ["S1", "P1", "S2"];
  const errors = validateDataset(dataset);

  assert.ok(errors.some((error) => error.includes("f2") && error.includes("before")), errors.join("\n"));
});

test("probe cannot check a superseded fact", () => {
  const dataset = tinyDataset();
  dataset.sessions.get("P1").checklist[0].fact = "f1";

  assert.ok(validateDataset(dataset).some((error) => error.includes("superseded")));
});

test("supersededBy must be planted same session or later", () => {
  const dataset = tinyDataset();
  dataset.facts[1].supersededBy = "f1";
  dataset.facts[0].supersededBy = null;

  assert.ok(validateDataset(dataset).some((error) => error.includes("f2") && error.includes("supersededBy")));
});

test("leak item must target another project", () => {
  const dataset = tinyDataset();
  dataset.sessions.get("P1").checklist[0].leak = true;

  assert.ok(validateDataset(dataset).some((error) => error.includes("leak")));

  dataset.facts[1].project = "shared";
  assert.ok(validateDataset(dataset).some((error) => error.includes("leak")));

  dataset.facts[1].project = "ingest";
  assert.deepEqual(validateDataset(dataset), []);
});

test("timeline lists every session exactly once", () => {
  const duplicate = tinyDataset();
  duplicate.timeline = ["S1", "S1", "S2", "P1"];
  assert.ok(validateDataset(duplicate).some((error) => error.includes("S1") && error.includes("twice")));

  const missing = tinyDataset();
  missing.timeline = ["S1", "S2"];
  assert.ok(validateDataset(missing).some((error) => error.includes("P1") && error.includes("timeline")));
});

test("plantedIn session must list the fact in plants", () => {
  const dataset = tinyDataset();
  dataset.sessions.get("S2").plants = [];

  assert.ok(validateDataset(dataset).some((error) => error.includes("f2") && error.includes("plants")));
});

test("factDistance counts timeline steps", () => {
  assert.equal(factDistance(["S1", "S2", "P1"], { plantedIn: "S1" }, "P1"), 2);
});

test("loadDataset reads facts, sessions, timeline and seeds", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-"));
  const dataset = tinyDataset();

  await fs.mkdir(path.join(dir, "scenarios", "relay", "seed"), { recursive: true });
  await fs.writeFile(path.join(dir, "facts.json"), JSON.stringify(dataset.facts));
  await fs.writeFile(path.join(dir, "timeline.json"), JSON.stringify(dataset.timeline));
  await fs.writeFile(path.join(dir, "scenarios", "relay", "sessions.json"), JSON.stringify([...dataset.sessions.values()]));

  const loaded = await loadDataset(dir);

  assert.deepEqual(validateDataset(loaded), []);
  assert.equal(loaded.seeds.relay, path.join(dir, "scenarios", "relay", "seed"));
  assert.equal(loaded.sessions.get("P1").kind, "probe");
});

test("shipped dataset is valid and covers the spec", async () => {
  const path = require("node:path");
  const dataset = await loadDataset(path.join(__dirname, "..", "bench", "continuity"));
  const sessions = [...dataset.sessions.values()];
  const probes = sessions.filter((session) => session.kind === "probe");
  const factsById = new Map(dataset.facts.map((fact) => [fact.id, fact]));
  const items = probes.flatMap((probe) => probe.checklist.map((item) => ({ probe, item, fact: factsById.get(item.fact) })));
  const distances = items.map(({ probe, fact }) => factDistance(dataset.timeline, fact, probe.id));

  assert.deepEqual(validateDataset(dataset), []);
  assert.equal(sessions.length, 21);
  assert.equal(probes.length, 7);
  // Facts with no trace in the code: a smoke recipe, a blocker, a parked branch, a cross-project preference.
  for (const id of ["ingest-smoke-flag", "ingest-vendor-c-blocked", "ingest-parked-dedupe", "pref-changelog"]) {
    assert.ok(items.some(({ item }) => item.fact === id && item.memory), id);
  }
  // Filler sessions plant nothing and check nothing.
  assert.ok(sessions.filter((session) => session.kind === "work" && !session.plants.length).length >= 2);

  for (const kind of ["state", "decision", "constraint", "asset", "done", "preference"]) {
    assert.ok(dataset.facts.filter((fact) => fact.kind === kind).length >= 2, kind);
  }

  assert.ok(dataset.facts.filter((fact) => fact.supersededBy).length >= 3);
  assert.ok(items.filter(({ probe, fact }) => probe.project === "ingest" && fact.project === "shared").length >= 2);
  assert.ok(items.some(({ item }) => item.leak));
  assert.ok(Math.min(...distances) <= 2);
  assert.ok(Math.max(...distances) >= 5);
  assert.ok(items.filter(({ item }) => item.memory).length >= 6);
  assert.match(dataset.sessions.get("B5").turns[1], /don't fix/);
});
