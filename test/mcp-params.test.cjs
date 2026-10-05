const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

function resultText(result) {
  return result.content.map((item) => item.text).join("\n");
}

test("MCP server rejects calls that would succeed but misbehave", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hippocamp-mcp-params-"));
  const lagoonRoot = path.join(tempRoot, "lagoon");
  const projectRoot = path.join(tempRoot, "params-project");

  await fs.mkdir(projectRoot, { recursive: true });
  execFileSync("git", ["init", "-q", projectRoot]);

  const client = new Client({ name: "hippocamp-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, "..", "scripts", "hippocamp-mcp.cjs")],
      cwd: projectRoot,
      env: { ...process.env, HIPPOCAMP_GLOBAL_ROOT: lagoonRoot, HIPPOCAMP_PROJECT_ROOT: projectRoot },
    }),
  );
  t.after(async () => {
    await client.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const eventWrite = await client.callTool({
    name: "write_memory_file",
    arguments: { scope: "project", path: "events/2026-09-29.md", content: "## Bypass\n\nNo index.", sync: false },
  });
  assert.equal(eventWrite.isError, true);
  assert.match(resultText(eventWrite), /append-only/);

  const noKeywords = await client.callTool({
    name: "append_event",
    arguments: { title: "Missing keywords", content: "Unsearchable.", sync: false },
  });
  assert.equal(noKeywords.isError, true);

  const tooManyKeywords = await client.callTool({
    name: "append_event",
    arguments: {
      title: "Too many keywords",
      keywords: Array.from({ length: 9 }, (_, index) => `keyword-${index}`),
      content: "Too broad.",
      sync: false,
    },
  });
  assert.equal(tooManyKeywords.isError, true);

  const noTitle = await client.callTool({
    name: "append_event",
    arguments: { title: " ", keywords: ["untitled"], content: "No heading.", sync: false },
  });
  assert.equal(noTitle.isError, true);

  const wrongProject = await client.callTool({
    name: "wake_up",
    arguments: { projectRoot: path.join(tempRoot, "missing-project") },
  });
  assert.equal(wrongProject.isError, true);
  assert.match(resultText(wrongProject), /Git repository/);

  const valid = await client.callTool({
    name: "append_event",
    arguments: { title: "Valid event", keywords: ["valid-keyword"], content: "Indexed.", projectRoot, sync: false },
  });
  assert.notEqual(valid.isError, true);
  assert.deepEqual(JSON.parse(resultText(valid)).keywords, ["valid-keyword"]);
});
