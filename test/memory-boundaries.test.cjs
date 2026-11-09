const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const memory = require("../scripts/hippocamp-memory.cjs");

async function lagoonWithEvent(t) {
  const originalRoot = process.env.HIPPOCAMP_GLOBAL_ROOT;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-bounds-"));
  const lagoonRoot = path.join(tempRoot, "lagoon");
  const projectRoot = path.join(tempRoot, "bounds-project");

  process.env.HIPPOCAMP_GLOBAL_ROOT = lagoonRoot;
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    } else {
      process.env.HIPPOCAMP_GLOBAL_ROOT = originalRoot;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await memory.appendEvent({ content: "Real decision.", keywords: ["real"], date: "2026-09-21", projectRoot, scope: "project", sync: false, timestamp: "2026-09-21T10:00:00.000Z", title: "Real event" });
  const [slug] = await fs.readdir(path.join(lagoonRoot, "projects"));
  return { tempRoot, lagoonRoot, projectRoot, slug, eventsDir: path.join(lagoonRoot, "projects", slug, "events") };
}

test("search ignores an index path that points outside the Lagoon", async (t) => {
  const { tempRoot, projectRoot, eventsDir } = await lagoonWithEvent(t);
  const id = "2026-09-22T10:00:00.000Z";
  await fs.writeFile(path.join(tempRoot, "outside.md"), `# Events\n\n## ${id} — Leaked secret\n\nKeywords:\n- [[leaked-secret]]\n\nTOPSECRET value\n`);
  await fs.writeFile(path.join(eventsDir, "2026-09-22.index.json"), JSON.stringify({ version: 1, path: "../../../../outside.md", events: [{ id, heading: "Leaked secret", keywords: ["leaked-secret"] }] }));

  const found = await memory.searchMemory({ projectRoot, query: "leaked secret", scope: "project" });

  assert.ok(!JSON.stringify(found).includes("TOPSECRET"), JSON.stringify(found));
});

test("a global write cannot replace a project's append-only event log", async (t) => {
  const { lagoonRoot, slug, eventsDir } = await lagoonWithEvent(t);
  const log = path.join(eventsDir, "2026-09-21.md");
  const before = await fs.readFile(log, "utf8");

  await assert.rejects(
    memory.writeMemoryFile({ scope: "global", path: `projects/${slug}/events/2026-09-21.md`, content: "wiped", sync: false }),
    /append-only/,
  );
  await assert.rejects(memory.writeMemoryFile({ scope: "global", path: `projects/${slug}/events/2026-09-21.index.json`, content: "{}", sync: false }), /append-only/);
  assert.equal(await fs.readFile(log, "utf8"), before);
  assert.ok(lagoonRoot);
});

test("symlinks inside the Lagoon cannot read or write files outside it", async (t) => {
  const { tempRoot, lagoonRoot, projectRoot, eventsDir } = await lagoonWithEvent(t);
  const outside = path.join(tempRoot, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.md"), "TOPSECRET outside file\n");

  // A curated file that is a link to an outside file: wake-up skips it, reads and writes refuse it.
  await fs.symlink(path.join(outside, "secret.md"), path.join(lagoonRoot, "identity.md"));
  const woke = await memory.wakeUp({ projectRoot });
  assert.ok(!woke.text.includes("TOPSECRET"), woke.text);
  await assert.rejects(memory.readMemoryFile({ scope: "global", path: "identity.md", projectRoot }), /memory root/);
  await assert.rejects(memory.writeMemoryFile({ scope: "global", path: "identity.md", content: "overwritten", sync: false }), /memory root/);
  assert.equal(await fs.readFile(path.join(outside, "secret.md"), "utf8"), "TOPSECRET outside file\n");

  // A linked folder: writing through it refuses too.
  await fs.symlink(outside, path.join(lagoonRoot, "linked"));
  await assert.rejects(memory.writeMemoryFile({ scope: "global", path: "linked/new.md", content: "x", sync: false }), /memory root/);
  assert.ok(!(await fs.readdir(outside)).includes("new.md"));

  // An event log linked to an outside file is not searched.
  const id = "2026-09-23T10:00:00.000Z";
  await fs.writeFile(path.join(outside, "events.md"), `# Events\n\n## ${id} — Linked secret\n\nKeywords:\n- [[linked-secret]]\n\nTOPSECRET linked log\n`);
  await fs.symlink(path.join(outside, "events.md"), path.join(eventsDir, "2026-09-23.md"));
  await fs.writeFile(path.join(eventsDir, "2026-09-23.index.json"), JSON.stringify({ version: 1, events: [{ id, heading: "Linked secret", keywords: ["linked-secret"] }] }));
  const found = await memory.searchMemory({ projectRoot, query: "linked secret", scope: "project" });
  assert.ok(!JSON.stringify(found).includes("TOPSECRET"), JSON.stringify(found));
});
