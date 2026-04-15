# Hippocamp

<p align="center">
  <img src="./assets/brand/hippocamp-mascot.png" alt="Hippocamp mascot" width="220" />
</p>

Hippocamp is local Git-backed memory for AI agents.

It gives Codex, Claude Code, and other MCP clients a small shared memory surface stored as plain Markdown in a repo you own. There is no database, hosted service, vector store, or token broker in the MVP.

## Why

Agents forget useful context between sessions. Hippocamp keeps that context inspectable:

- memory is Markdown
- storage is a local Git clone
- sync is normal `git commit` and `git push`
- agents access it through MCP tools

## Install

Clone this repo, install dependencies, then install the MCP server for your agent:

```bash
npm install
npm run install:codex
```

For Claude Code:

```bash
npm install
npm run install:claude
```

After publishing, the intended one-line install shape is:

```bash
npx hippocamp install-codex
```

Upgrade uses the same install path, so agents can refresh themselves without a separate state model:

```bash
npx hippocamp@latest upgrade-codex
npx hippocamp@latest upgrade-claude
```

From a source checkout:

```bash
git pull --ff-only
npm install
npm run upgrade:codex
npm run upgrade:claude
```

Both installers default to `~/.lagoon` as the memory repo. You can override it:

```bash
npm run install:codex -- --global-root /absolute/path/to/lagoon
npm run install:claude -- --global-root /absolute/path/to/lagoon
```

The Codex installer refreshes `~/.codex/AGENTS.md`. The Claude installer refreshes `~/.claude/CLAUDE.md`.
Both managed instruction blocks tell the agent to call `wake_up` at the start of new top-level coding tasks before repo exploration or edits.

## Lagoon Repo

Hippocamp expects a local Git repo for memory:

```bash
git clone git@github.com:YOUR_USER/lagoon.git ~/.lagoon
```

The repo can be private. Hippocamp does not need a GitHub token for local MCP mode. It uses your normal local Git credentials.

If push auth is not configured yet, use your preferred GitHub setup. With GitHub CLI:

```bash
gh auth login
gh auth setup-git
cd ~/.lagoon
git push --dry-run
```

Once `git push --dry-run` works from `~/.lagoon`, Hippocamp can sync memory.

## Memory Layout

Global memory lives in:

```text
~/.lagoon/
```

Project memory lives in:

```text
~/.lagoon/projects/<project-slug>/
```

Suggested files:

```text
identity.md
how_i_work.md
preferences.md
open_loops.md
events/YYYY-MM-DD.md
projects/<project-slug>/
  project.md
  current_state.md
  open_threads.md
  events/YYYY-MM-DD.md
```

## MCP Tools

The local MCP server exposes:

- `wake_up`
- `read_memory_file`
- `write_memory_file`
- `append_event`
- `list_memory_files`
- `search_memory`
- `sync_memory`

Typical agent flow:

1. Call `wake_up` at the start of a top-level task.
2. Read the returned global and project memory.
3. Use `search_memory` only when wake-up files are not enough.
4. Use `append_event` for meaningful milestones.
5. Update curated files like `current_state.md` and `open_threads.md` before finishing.

Writes sync by default. If sync fails or is skipped, call `sync_memory`.

## Memory Rules

- Keep memory concise.
- Prefer curated summaries over raw event history.
- Do not duplicate GitHub-owned facts such as commits, PRs, issues, reviews, or CI results.
- Store artifact references plus the missing rationale, preference, assumption, or follow-up context.
- Use project scope for project-specific state.
- Use global scope only for durable context that should follow you across projects.

Example event content:

```md
References:
- commit: abc1234
- pr: #12

Decision:
Keep the local MCP path token-free and rely on normal git credentials.

Why:
This reduces onboarding friction for open-source users and avoids cloud auth concerns in the MVP.
```

## Commands

```bash
npm run mcp
npm run mcp:help
npm run mcp:smoke
npm run install:codex
npm run install:claude
npm run upgrade:codex
npm run upgrade:claude
```

## Configuration

Environment variables are optional for local use:

- `HIPPOCAMP_GLOBAL_ROOT`: local Lagoon clone path. Default: `~/.lagoon`
- `HIPPOCAMP_PROJECT_ROOT`: project root used to infer the current project slug. Default: current working directory

## What This Is Not

- Not a hosted cloud service
- Not a database
- Not a notes app
- Not a vector store
- Not a queue

The cloud/API version can be redesigned later. The MVP is intentionally local-first and Git-native.
