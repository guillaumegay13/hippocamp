// Reporting for the continuity benchmark: outcome, breakdown, efficiency and memory quality per arm,
// pooled over runs, with a probe-level bootstrap for differences between arms.
const { ARMS } = require("./continuity-adapters.cjs");

const KINDS = ["state", "decision", "constraint", "asset", "done", "preference"];
const BANDS = [
  ["1-2", (distance) => distance <= 2],
  ["3-5", (distance) => distance >= 3 && distance <= 5],
  ["6+", (distance) => distance >= 6],
];

const graded = (rows) => rows.filter((row) => row.pass !== null);

// N/A items (pass === null) count in neither direction.
function passRate(rows) {
  const scored = graded(rows);
  const passed = scored.filter((row) => row.pass).length;
  return scored.length ? `${Math.round((100 * passed) / scored.length)}% (${passed}/${scored.length})` : "-";
}

function armsIn(...lists) {
  const names = new Set(lists.flat().map((entry) => entry.system));
  const rank = (name) => (ARMS.includes(name) ? ARMS.indexOf(name) : ARMS.length);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const runsOf = (system, ...lists) => new Set(lists.flat().filter((entry) => entry.system === system).map((entry) => entry.run)).size;

function table(header, rows) {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((cells) => `| ${cells.join(" | ")} |`)].join("\n");
}

// Items that really need memory: the no-memory arm fails them in every one of its runs.
function memoryRequired(rows) {
  const none = rows.filter((row) => row.system === "cc-none");

  if (!none.length) {
    return null;
  }

  const items = new Set(none.map((row) => row.item));
  return new Set([...items].filter((item) => none.filter((row) => row.item === item).every((row) => row.pass === false)));
}

function requiredRows(rows, required) {
  return rows.filter((row) => (required ? required.has(row.item) : row.memory));
}

function summarize(rows, records) {
  const required = memoryRequired(rows);
  const lines = armsIn(rows, records).map((system) => {
    const mine = rows.filter((row) => row.system === system);
    const runs = runsOf(system, rows, records) || 1;
    const cost = records.filter((record) => record.system === system).reduce((sum, record) => sum + (record.costUsd || 0), 0);
    return [system, String(runs), passRate(mine), passRate(requiredRows(mine, required)), String(mine.filter((row) => row.pass === null).length), `$${(cost / runs).toFixed(2)}`];
  });
  const note = required
    ? `Memory-required = items cc-none fails in every run (${required.size} items). Agent $ is per run, at API price.`
    : "Agent $ is per run, at API price. Note: no cc-none run: memory-required falls back to the dataset's memory flag.";

  return `${table(["Arm", "Runs", "Pass", "Memory-required", "n/a", "Agent $"], lines)}\n\n${note}`;
}

function breakdownTable(rows) {
  const header = ["Arm", ...KINDS, ...BANDS.map(([label]) => label)];
  const lines = armsIn(rows).map((system) => {
    const mine = rows.filter((row) => row.system === system);
    return [system, ...KINDS.map((kind) => passRate(mine.filter((row) => row.kind === kind))), ...BANDS.map(([, inBand]) => passRate(mine.filter((row) => inBand(row.distance))))];
  });

  return table(header, lines);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function efficiencyTable(records, rows) {
  const required = memoryRequired(rows);
  const header = ["Arm", "Tokens/session (median)", "Time/session (median)", "Memory calls/session", "Memory bytes/session", "$ per run", "Memory tokens per memory-required pass"];
  const lines = armsIn(records).map((system) => {
    const mine = records.filter((record) => record.system === system);
    const measured = mine.filter((record) => record.tokens);
    const runs = runsOf(system, records) || 1;
    const cost = `$${(mine.reduce((sum, record) => sum + (record.costUsd || 0), 0) / runs).toFixed(2)}`;

    if (!measured.length) {
      return [system, "-", "-", "-", "-", cost, "-"];
    }

    const memoryBytes = measured.map((record) => (record.memoryBytesIn || 0) + (record.autoLoadedBytes || 0));
    const passes = graded(requiredRows(rows.filter((row) => row.system === system), required)).filter((row) => row.pass).length;
    const totalTokens = measured.map((record) => Object.values(record.tokens).reduce((sum, value) => sum + value, 0));

    return [
      system,
      String(median(totalTokens)),
      `${(median(measured.map((record) => record.durationMs || 0)) / 1000).toFixed(1)}s`,
      mean(measured.map((record) => record.memoryCalls || 0)).toFixed(1),
      String(Math.round(mean(memoryBytes))),
      cost,
      passes ? String(Math.round(memoryBytes.reduce((sum, value) => sum + value, 0) / 4 / passes)) : "-",
    ];
  });

  return table(header, lines);
}

// qualities: { arm: [quality per run, or null for an arm without memory] }
function qualityTable(qualities) {
  const header = ["Arm", "Entries", "Coverage", "Precision", "Stale", "Noise", "Duplicates"];
  const percent = (value) => `${Math.round(100 * value)}%`;
  const lines = Object.entries(qualities).map(([system, runs]) => {
    const measured = runs.filter(Boolean);

    if (!measured.length) {
      return [system, "-", "-", "-", "-", "-", "-"];
    }

    const avg = (key) => mean(measured.map((quality) => quality[key] ?? 0));
    return [system, String(Math.round(avg("entries"))), percent(avg("coverage")), percent(avg("precision")), avg("stale").toFixed(1), avg("noise").toFixed(1), avg("duplicates").toFixed(1)];
  });

  return table(header, lines);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Difference in pass rate (A minus B) with a 95% interval from resampling probes, which are the independent units.
function bootstrapDiff(rowsA, rowsB, { iterations = 2000, seed = 1 } = {}) {
  const probes = [...new Set([...rowsA, ...rowsB].map((row) => row.probe))].sort();
  const byProbe = (rows) => new Map(probes.map((probe) => [probe, graded(rows.filter((row) => row.probe === probe))]));
  const a = byProbe(rowsA);
  const b = byProbe(rowsB);
  const rate = (groups, sample) => {
    const items = sample.flatMap((probe) => groups.get(probe));
    return items.length ? items.filter((row) => row.pass).length / items.length : 0;
  };
  const random = mulberry32(seed);
  const diffs = [];

  for (let index = 0; index < iterations; index += 1) {
    const sample = probes.map(() => probes[Math.floor(random() * probes.length)]);
    diffs.push(rate(a, sample) - rate(b, sample));
  }

  diffs.sort((x, y) => x - y);
  const round = (value) => Math.round(value * 1000) / 1000;
  return { diff: round(rate(a, probes) - rate(b, probes)), low: round(diffs[Math.floor(0.025 * iterations)]), high: round(diffs[Math.ceil(0.975 * iterations) - 1]) };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// One row per judged item with empty human columns, for checking the judge by hand.
function validationSheet(rows, { sessions, facts }) {
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const header = "system,probe,item,memory,check,fact,judge_pass,judge_cause,evidence,human_pass,human_note";
  const lines = rows.map((row) => {
    const check = sessions.get(row.probe).checklist.find((entry) => entry.id === row.item).check;
    const cells = [row.system, row.probe, row.item, row.memory, check, factsById.get(row.fact)?.statement, row.pass === null ? "n/a" : row.pass, row.cause, row.evidence, "", ""];
    return cells.map(csvCell).join(",");
  });

  return `${[header, ...lines].join("\n")}\n`;
}

module.exports = { bootstrapDiff, breakdownTable, efficiencyTable, memoryRequired, passRate, qualityTable, summarize, validationSheet };
