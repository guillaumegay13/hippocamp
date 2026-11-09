const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const memory = require("../scripts/hippocamp-memory.cjs");

async function cacheDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-update-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "update-check.json");
}

const registry = (version, calls) => async (url) => {
  calls.push(url);
  return { ok: true, json: async () => ({ version }) };
};

test("a newer npm version produces a notice, checked at most once a day", async (t) => {
  const cachePath = await cacheDir(t);
  const calls = [];
  const options = { enabled: true, currentVersion: "0.2.14", cachePath, fetchImpl: registry("0.2.15", calls), now: Date.parse("2026-11-09T10:00:00Z") };

  assert.deepEqual(await memory.checkForUpdate(options), { current: "0.2.14", latest: "0.2.15" });
  assert.deepEqual(await memory.checkForUpdate({ ...options, now: options.now + 3600000 }), { current: "0.2.14", latest: "0.2.15" });
  assert.equal(calls.length, 1);
  await memory.checkForUpdate({ ...options, now: options.now + 25 * 3600000 });
  assert.equal(calls.length, 2);
});

test("no notice when up to date, offline, or turned off", async (t) => {
  const cachePath = await cacheDir(t);
  const calls = [];

  assert.equal(await memory.checkForUpdate({ enabled: true, currentVersion: "0.2.15", cachePath, fetchImpl: registry("0.2.15", calls) }), null);
  assert.equal(await memory.checkForUpdate({ enabled: true, currentVersion: "0.2.10", cachePath: `${cachePath}.2`, fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await memory.checkForUpdate({ enabled: false, currentVersion: "0.2.10", cachePath: `${cachePath}.3`, fetchImpl: registry("9.9.9", calls) }), null);
  assert.equal(await memory.checkForUpdate({ enabled: true, currentVersion: "0.2.10", cachePath: `${cachePath}.4`, fetchImpl: registry("0.2.9", calls) }), null);
});

test("wake_up shows the update notice and asks the agent to check with the user", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-update-wake-"));
  const previous = process.env.HIPPOCAMP_GLOBAL_ROOT;
  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(root, "lagoon");
  t.after(async () => {
    if (previous === undefined) delete process.env.HIPPOCAMP_GLOBAL_ROOT;
    else process.env.HIPPOCAMP_GLOBAL_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await memory.wakeUp({ projectRoot: path.join(root, "project"), checkUpdate: async () => ({ current: "0.2.14", latest: "0.2.15" }) });

  assert.deepEqual(result.update, { current: "0.2.14", latest: "0.2.15" });
  assert.match(result.text, /Hippocamp 0\.2\.15 is available \(installed 0\.2\.14\)/);
  assert.match(result.text, /npx hippocamp@latest upgrade/);
  assert.match(result.text, /[Aa]sk the user/);
});
