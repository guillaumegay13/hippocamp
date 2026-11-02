const test = require("node:test");
const assert = require("node:assert/strict");
const { bootstrapDiff, breakdownTable, efficiencyTable, memoryRequired, passRate, qualityTable, summarize } = require("../scripts/continuity-report.cjs");

const probeRows = (system, values) => values.map((value, index) => ({ system, run: "1", probe: `p${index}`, item: `p${index}-1`, pass: Boolean(value), memory: true }));

test("passRate shows n and leaves n/a out", () => {
  assert.equal(passRate([{ pass: true }, { pass: false }, { pass: null }]), "50% (1/2)");
  assert.equal(passRate([{ pass: null }]), "-");
});

test("memoryRequired keeps items cc-none fails in every run", () => {
  const rows = [
    { system: "cc-none", run: "1", item: "x", pass: false },
    { system: "cc-none", run: "2", item: "x", pass: false },
    { system: "cc-none", run: "1", item: "y", pass: true },
    { system: "cc-none", run: "2", item: "y", pass: false },
    { system: "cc-native", run: "1", item: "z", pass: false },
  ];

  assert.deepEqual([...memoryRequired(rows)], ["x"]);
  assert.equal(memoryRequired(rows.filter((row) => row.system !== "cc-none")), null);
});

test("summarize counts runs and uses cc-none to define memory-required items", () => {
  const rows = [
    { system: "cc-none", run: "1", item: "x", pass: false, memory: true },
    { system: "cc-none", run: "1", item: "y", pass: true, memory: true },
    { system: "cc-hippocamp", run: "1", item: "x", pass: true, memory: true },
    { system: "cc-hippocamp", run: "1", item: "y", pass: false, memory: true },
    { system: "cc-hippocamp", run: "2", item: "x", pass: true, memory: true },
    { system: "cc-hippocamp", run: "2", item: "y", pass: null, memory: true },
  ];
  const records = [
    { system: "cc-hippocamp", run: "1", costUsd: 1 },
    { system: "cc-hippocamp", run: "2", costUsd: 3 },
  ];
  const table = summarize(rows, records);
  const row = table.split("\n").find((line) => line.startsWith("| cc-hippocamp |"));

  assert.equal(row, "| cc-hippocamp | 2 | 67% (2/3) | 100% (2/2) | 1 | $2.00 |");
  assert.match(table, /Memory-required = items cc-none fails in every run/);
});

test("summarize falls back to the dataset memory flag without cc-none", () => {
  const table = summarize([{ system: "cc-native", run: "1", item: "x", pass: true, memory: true }, { system: "cc-native", run: "1", item: "y", pass: false, memory: false }], []);

  assert.match(table, /\| cc-native \| 1 \| 50% \(1\/2\) \| 100% \(1\/1\) \|/);
  assert.match(table, /no cc-none run: memory-required falls back to the dataset's memory flag/);
});

test("breakdownTable shows n for each kind and distance band", () => {
  const table = breakdownTable([
    { system: "cc-native", kind: "decision", distance: 2, pass: true },
    { system: "cc-native", kind: "decision", distance: 7, pass: false },
  ]);

  assert.match(table, /\| cc-native \| .*50% \(1\/2\)/);
  assert.ok(table.split("\n")[0].includes("| 1-2 | 3-5 | 6+ |"));
});

test("efficiencyTable reports medians, memory overhead and memory tokens per memory-required pass", () => {
  const records = [
    { system: "cc-hippocamp", run: "1", costUsd: 2, durationMs: 1000, memoryCalls: 2, memoryBytesIn: 400, autoLoadedBytes: 400, tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } },
    { system: "cc-hippocamp", run: "1", costUsd: 2, durationMs: 3000, memoryCalls: 0, memoryBytesIn: 0, autoLoadedBytes: 0, tokens: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 } },
  ];
  const rows = [{ system: "cc-hippocamp", run: "1", item: "x", pass: true, memory: true }];
  const line = efficiencyTable(records, rows).split("\n").find((text) => text.startsWith("| cc-hippocamp |"));

  assert.equal(line, "| cc-hippocamp | 30 | 2.0s | 1.0 | 400 | $4.00 | 200 |");
});

test("efficiencyTable tolerates records from before efficiency capture", () => {
  const line = efficiencyTable([{ system: "cc-native", run: "1", costUsd: 1 }], []).split("\n").find((text) => text.startsWith("| cc-native |"));

  assert.equal(line, "| cc-native | - | - | - | - | $1.00 | - |");
});

test("qualityTable averages runs and shows dashes for arms without memory", () => {
  const table = qualityTable({
    "cc-native": [{ entries: 10, coverage: 0.5, precision: 0.6, stale: 2, noise: 3, duplicates: 1 }, { entries: 20, coverage: 0.7, precision: 0.4, stale: 0, noise: 5, duplicates: 1 }],
    "cc-none": [null],
  });

  assert.match(table, /\| cc-native \| 15 \| 60% \| 50% \| 1\.0 \| 4\.0 \| 1\.0 \|/);
  assert.match(table, /\| cc-none \| - \| - \| - \| - \| - \| - \|/);
});

test("bootstrapDiff is reproducible and brackets the observed difference", () => {
  const a = probeRows("A", [1, 1, 1, 1]);
  const b = probeRows("B", [1, 0, 1, 0]);
  const first = bootstrapDiff(a, b);

  assert.deepEqual(bootstrapDiff(a, b), first);
  assert.equal(first.diff, 0.5);
  assert.ok(first.low <= 0.5 && first.high >= 0.5 && first.low >= 0);
});
