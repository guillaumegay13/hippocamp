const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("published files contain no local home directory paths", () => {
  const root = path.join(__dirname, "..");
  // npm is npm.cmd on Windows, which Node only runs through a shell.
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const [pack] = JSON.parse(output);
  const textFiles = pack.files.map((file) => file.path).filter((file) => !file.endsWith(".png"));
  const matches = [];

  for (const file of textFiles) {
    const content = fs.readFileSync(path.join(root, file), "utf8");

    for (const [index, line] of content.split("\n").entries()) {
      if (/\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+/.test(line)) {
        matches.push(`${file}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(matches, []);
});

test("the README graph image stays out of the npm package", () => {
  // The README loads it from GitHub; .npmignore keeps the 250 kB file out of every install.
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const [pack] = JSON.parse(output);

  assert.ok(!pack.files.some((file) => file.path.startsWith("assets/brand/lagoon-graph")));
});

test("benchmarks, their data and the test suite stay out of the npm package", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const [pack] = JSON.parse(output);
  const leaked = pack.files.map((file) => file.path).filter((file) => /^(bench\/|docs\/results\/|\.context\/|test\/|scripts\/(eval-|continuity-))/.test(file));

  assert.deepEqual(leaked, []);
});
