#!/usr/bin/env node

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const nodePath = require("node:path");
const { z } = require("zod");
const memory = require("./hippocamp-memory.cjs");

function toTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function printHelp() {
  console.log(`Hippocamp MCP server

Runs a local stdio MCP server for Hippocamp memory.

Environment:
  HIPPOCAMP_GLOBAL_ROOT   Local path to the Lagoon clone. Default: ~/.lagoon
  HIPPOCAMP_PROJECT_ROOT  Default project root. Default: current working directory

Tools:
  wake_up
  read_memory_file
  write_memory_file
  append_event
  list_memory_files
  search_memory
  sync_memory
`);
}

async function runSmoke() {
  const wake = await memory.wakeUp({});
  console.log(JSON.stringify(wake, null, 2));
}

async function main() {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  if (process.argv.includes("--smoke")) {
    await runSmoke();
    return;
  }

  const server = new McpServer({
    name: "hippocamp",
    version: "0.1.0",
  });

  server.registerTool(
    "wake_up",
    {
      description:
        "Load the default global and project wake-up files. Use this at the start of a top-level task thread.",
      inputSchema: {
        projectRoot: z.string().optional(),
      },
    },
    async ({ projectRoot }) => toTextResult(await memory.wakeUp({ projectRoot })),
  );

  server.registerTool(
    "read_memory_file",
    {
      description: "Read one memory file from either global memory or the current project's .hippocamp folder.",
      inputSchema: {
        scope: z.enum(["global", "project"]),
        path: z.string(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ scope, path, projectRoot }) =>
      toTextResult(await memory.readMemoryFile({ scope, path, projectRoot })),
  );

  server.registerTool(
    "write_memory_file",
    {
      description:
        "Create or overwrite one memory file. Use this for curated files like identity.md, current_state.md, or open_threads.md.",
      inputSchema: {
        scope: z.enum(["global", "project"]),
        path: z.string(),
        content: z.string(),
        sync: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ scope, path, content, sync, projectRoot }) =>
      toTextResult(await memory.writeMemoryFile({ scope, path, content, projectRoot, sync })),
  );

  server.registerTool(
    "append_event",
    {
      description:
        "Append a dated event entry under events/YYYY-MM-DD.md. Prefer this for milestone logging instead of rewriting curated summaries.",
      inputSchema: {
        scope: z.enum(["global", "project"]).default("project"),
        title: z.string().optional(),
        content: z.string(),
        sync: z.boolean().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ scope, title, content, sync, projectRoot }) =>
      toTextResult(await memory.appendEvent({ scope, title, content, projectRoot, sync })),
  );

  server.registerTool(
    "list_memory_files",
    {
      description: "List files under global memory or the project .hippocamp folder.",
      inputSchema: {
        scope: z.enum(["global", "project"]),
        path: z.string().optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ scope, path, projectRoot }) =>
      toTextResult({
        scope,
        root: memory.getScopeRoot(scope, projectRoot),
        items: await memory.listDirectoryEntries(scope, path || ".", projectRoot),
      }),
  );

  server.registerTool(
    "search_memory",
    {
      description:
        "Search Markdown memory files. Use this only when the wake-up files are insufficient, not as the default startup path.",
      inputSchema: {
        query: z.string(),
        scope: z.enum(["global", "project", "both"]).default("both"),
        maxResults: z.number().int().min(1).max(20).optional(),
        projectRoot: z.string().optional(),
      },
    },
    async ({ query, scope, maxResults, projectRoot }) =>
      toTextResult(await memory.searchMemory({ query, scope, maxResults, projectRoot })),
  );

  server.registerTool(
    "sync_memory",
    {
      description:
        "Commit and push memory changes. Global memory syncs through the dedicated Lagoon clone; project sync only proceeds when the repo has no unrelated changes outside .hippocamp.",
      inputSchema: {
        scope: z.enum(["global", "project"]),
        path: z.string().optional(),
        projectRoot: z.string().optional(),
        message: z.string().optional(),
      },
    },
    async ({ scope, path, projectRoot, message }) => {
      const scopeRoot = memory.getScopeRoot(scope, projectRoot);
      const targetPath = path
        ? nodePath.resolve(scopeRoot, path)
        : scope === "global"
          ? scopeRoot
          : nodePath.join(scopeRoot);

      return toTextResult(
        await memory.syncMemory({
          scope,
          projectRoot,
          paths: [targetPath],
          message: message || `hippocamp: sync ${scope} memory`,
        }),
      );
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Hippocamp MCP server error:", error);
  process.exit(1);
});
