const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ADAPTERS } = require("../scripts/continuity-adapters.cjs");
const { attributeMisses, blindDigest, judgeProbe } = require("../scripts/continuity-judge.cjs");

const root = "/bench/r1/cc-hippocamp";
const paths = {
  root,
  home: `${root}/sandbox-home`,
  configDir: `${root}/sandbox-home/.claude`,
  lagoon: `${root}/lagoon`,
  repos: { relay: `${root}/repos/relay`, ingest: `${root}/repos/ingest` },
};
const probe = {
  id: "P1",
  turns: ["add retry metrics"],
  checklist: [
    { id: "P1-1", fact: "f1", check: "Reads Postgres." },
    { id: "P1-2", fact: "f2", check: "No new deps." },
  ],
};
const facts = [
  { id: "f1", statement: "Postgres." },
  { id: "f2", statement: "No deps." },
];

test("blindDigest hides which arm ran", () => {
  const calls = [
    { name: "mcp__hippocamp__search_memory", input: { query: "chunk" }, result: `Hippocamp found ${paths.lagoon}/projects/relay/events/a.md` },
    { name: "Read", input: { file_path: `${paths.configDir}/projects/x/memory/MEMORY.md` }, result: "index" },
    { name: "Edit", input: { file_path: `${paths.repos.relay}/src/a.ts` } },
  ];
  const text = blindDigest(calls, "done, saved to hippocamp", { adapter: ADAPTERS["cc-hippocamp"], paths });

  for (const leak of ["hippocamp", "Hippocamp", ".claude/projects", "lagoon", "cc-", "native", root]) {
    assert.ok(!text.includes(leak), `${leak} leaked:\n${text}`);
  }

  assert.match(text, /memory_tool/);
  assert.match(text, /<repo>\/src\/a\.ts/);
});

test("task judge prompt has no memory snapshot and no arm names", async () => {
  let prompt = "";
  const complete = async (model, request) => {
    prompt = request.messages[0].content;
    return { text: '{"items":[{"id":"P1-1","pass":true,"evidence":"uses pg"}]}' };
  };
  const items = await judgeProbe({ session: probe, facts, diff: "d", digest: "g", judgeModel: "m", complete });

  assert.ok(!/hippocamp|native|snapshot|memory available/i.test(prompt), prompt);
  assert.deepEqual(items, [
    { item: "P1-1", pass: true, evidence: "uses pg" },
    { item: "P1-2", pass: false, evidence: "", cause: "judge-missing" },
  ]);
});

test("attributeMisses only sends failed items and keeps the six causes", async () => {
  let prompt = "";
  const complete = async (model, request) => {
    prompt = request.messages[0].content;
    return { text: '{"items":[{"id":"P1-1","cause":"stale-memory","source":"memory"}]}' };
  };
  const causes = await attributeMisses({ session: probe, facts, misses: ["P1-1"], snapshot: "chunks of 10k", digest: "g", judgeModel: "m", complete });

  assert.ok(prompt.includes("P1-1") && !prompt.includes("P1-2"));
  assert.ok(prompt.includes("chunks of 10k"));
  assert.deepEqual(causes, [{ item: "P1-1", cause: "stale-memory", source: "memory" }]);
});

test("attributeMisses maps an unknown cause to unknown", async () => {
  const complete = async () => ({ text: '{"items":[{"id":"P1-1","cause":"forgot"}]}' });
  const [cause] = await attributeMisses({ session: probe, facts, misses: ["P1-1"], snapshot: "", digest: "", judgeModel: "m", complete });

  assert.equal(cause.cause, "unknown");
  assert.equal(path.basename("x"), "x");
});
