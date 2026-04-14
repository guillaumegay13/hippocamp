# Hippocamp

<p align="center">
  <img src="./public/brand/hippocamp-mascot.png" alt="Hippocamp mascot" width="220" />
</p>

Hippocamp is a minimal shared memory layer for AI agents. It stores memory as plain Markdown files inside a GitHub repository and exposes a small Next.js API that reads and writes those files directly through the GitHub REST API.

The product is intentionally narrow:

- It is not a notes app.
- It is not a database.
- It is not a vector or embeddings system.
- It is a Git-backed shared memory surface that stays inspectable and hackable.

## Stack

- Next.js App Router with TypeScript
- Vercel for deployment
- GitHub as the storage backend
- Markdown `.md` files as the memory format

## Required environment variables

Set these in local development and in Vercel:

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH`

The token needs permission to read and write contents in the target repository.

An `.env.example` file is included as a starting point.

## Memory model

All memory lives under `.hippocamp/` in the configured GitHub repository:

- `.hippocamp/events/YYYY-MM-DD.md`
- `.hippocamp/agents/{agentName}.md`
- `.hippocamp/shared/context.md`
- additional curated files like `.hippocamp/project.md` or `.hippocamp/current_state.md` can be managed directly through the file API

### Rules

- Events are append-only.
- Each agent owns its own file under `.hippocamp/agents/`.
- Shared context is curated and only updated by the dream endpoint.

### Default Markdown shapes

Event files are created on first write with a date heading and then append formatted event blocks:

```md
# Events — 2026-04-08

## 2026-04-08T21:10:00Z — code_change
Agent: agent-builder
Project: mytrainer
Commit: abc1234

What changed:
Added support for dynamic scope escalation in MCP routes.

Why:
The previous flow did not preserve required scopes for reauthorization.

Impact:
Clients can now receive structured insufficient-scope responses.

Next:
Validate behavior with Claude Desktop.
```

Agent working memory can be initialized with:

```md
# Agent: agent-builder

## Current Focus

## Recent Activity

## Open Questions

## Next Actions
```

Shared context follows:

```md
# Shared Context

## Current State

## Key Facts

## Recent Decisions

## Open Threads
```

## API endpoints

### `GET /api/health`

Returns a simple status payload and whether GitHub configuration is present.

### `GET /api/memory/file?path=.hippocamp/shared/context.md`

Reads one Markdown file from the GitHub-backed memory tree and returns content plus basic metadata.

### `PUT /api/memory/file`

Creates or overwrites one Markdown file under `.hippocamp/`.

Example payload:

```json
{
  "path": ".hippocamp/current_state.md",
  "content": "# Current State\n\n- Trying the first Git-backed Hippocamp workflow.\n"
}
```

### `GET /api/memory/list?path=.hippocamp`

Lists the children of a directory under `.hippocamp/`.

### `GET /api/memory/search?q=builder`

Performs naive case-insensitive substring search across Markdown files under `.hippocamp/`. V1 recursively traverses the tree and returns matching file paths with short snippets.

### `POST /api/memory/append-event`

Appends a formatted event entry to the current UTC daily log in `.hippocamp/events/YYYY-MM-DD.md`.

Example payload:

```json
{
  "agent": "agent-builder",
  "type": "code_change",
  "project": "mytrainer",
  "commit": "abc1234",
  "whatChanged": "Added support for dynamic scope escalation in MCP routes.",
  "why": "The previous flow did not preserve required scopes for reauthorization.",
  "impact": "Clients can now receive structured insufficient-scope responses.",
  "next": "Validate behavior with Claude Desktop."
}
```

### `POST /api/memory/update-agent`

Creates or overwrites one agent memory file at `.hippocamp/agents/{agent}.md`.

Example payload:

```json
{
  "agent": "agent-builder",
  "content": "# Agent: agent-builder\n\n## Current Focus\nShip the API.\n"
}
```

### `POST /api/memory/dream`

Manual summarization mode for V1. It reads recent events and agent files, generates a deterministic shared summary, and writes the result to `.hippocamp/shared/context.md`.

## GitHub write behavior

Writes go through the GitHub contents API and commit directly to the configured branch.

- Event commit messages look like `append event: code_change by agent-builder`
- Agent updates use `update agent memory: agent-builder`
- Dream updates use `dream: refresh shared context`

To reduce coordination complexity in V1:

- event logs are append-only
- agent files are isolated per agent
- shared context updates only through dream mode

If GitHub rejects a write because the file SHA is stale, the server refetches the latest file and retries once.

## Local development

Install dependencies and run the dev server:

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Local MCP server

For local agent autopilot, run the stdio MCP server instead of deploying the Next.js app:

```bash
npm run mcp
```

Helpful commands:

```bash
npm run install:claude
npm run install:codex
npm run mcp:help
npm run mcp:smoke
```

One-command installers:

- Codex: `npm run install:codex`
- Claude Code: `npm run install:claude`

To install Hippocamp into Codex in one step, run:

```bash
npm run install:codex
```

That command:

- installs the `hippocamp-memory` skill into `~/.codex/skills/`
- registers the local stdio MCP server with `codex mcp add`
- points global memory at the Lagoon clone in `~/.lagoon` by default

You can override the global memory root:

```bash
node scripts/install-codex.cjs --global-root /absolute/path/to/your/global/memory/clone
```

To install Hippocamp into Claude Code in one step, run:

```bash
npm run install:claude
```

That command:

- registers the local stdio MCP server with `claude mcp add --scope user`
- points global memory at the Lagoon clone in `~/.lagoon` by default
- installs the `hippocamp-memory` skill into `~/.claude/skills/hippocamp-memory/`
- creates or updates `~/.claude/CLAUDE.md` with a small Hippocamp block that tells Claude to:
  - call `wake_up` at the start of top-level tasks
  - search memory only on demand
  - checkpoint project memory before the final response after meaningful changes
  - read the Karpathy guidelines file before coding unless explicitly told to skip it

You can override the global memory root:

```bash
node scripts/install-claude.cjs --global-root /absolute/path/to/your/global/memory/clone
```

Environment:

- `HIPPOCAMP_GLOBAL_ROOT` points to the local clone of your Lagoon repo. Global memory lives under its `.hippocamp/` folder, and per-project personal memory lives under `.hippocamp/projects/<slug>/`. Default: `~/.lagoon`
- `HIPPOCAMP_PROJECT_ROOT` optionally overrides the project root used to infer the current project slug. Default: current working directory

If you use `lagoon` as the global memory repo, clone it to `~/.lagoon` or point `HIPPOCAMP_GLOBAL_ROOT` at another local clone path.

The local MCP server exposes these tools:

- `wake_up`
- `read_memory_file`
- `write_memory_file`
- `append_event`
- `list_memory_files`
- `search_memory`
- `sync_memory`

Default sync behavior:

- Global memory writes commit and push automatically when `~/.lagoon` is a git clone of your global memory repo.
- Project memory writes also sync through that same Lagoon clone, under `.hippocamp/projects/<slug>/`.
- All Hippocamp reads, writes, and syncs stay inside the selected `.hippocamp/` root. `sync_memory` cannot stage arbitrary files elsewhere in the repo.
- When default sync is skipped or fails, call `sync_memory`.

The installable skill for agents lives under `skills/hippocamp-memory/`.
For Claude Code, `npm run install:claude` installs that same skill into `~/.claude/skills/hippocamp-memory/`, adds the Hippocamp MCP server, and refreshes `~/.claude/CLAUDE.md`.

## V1 limitations

- Search is naive and reads Markdown files directly from GitHub.
- There is no auth layer beyond the server-side GitHub token.
- There is no database, queue, background worker, or semantic retrieval.
- Dream mode uses deterministic summarization rather than an LLM.
- There is no branch-per-agent or PR-per-write workflow.
