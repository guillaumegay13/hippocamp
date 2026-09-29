const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

test("published files contain no local home directory paths", () => {
  const root = path.join(__dirname, "..");
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
  const textFiles = pack.files.map((file) => file.path).filter((file) => !file.endsWith(".png"));
  const matches = [];

  for (const file of textFiles) {
    const content = require("node:fs").readFileSync(path.join(root, file), "utf8");

    for (const [index, line] of content.split("\n").entries()) {
      if (/\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+/.test(line)) {
        matches.push(`${file}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(matches, []);
});
