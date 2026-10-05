# How It Works

[← Back to README](../README.md)

## What It Stores

- durable preferences and working style
- current project state and open threads
- meaningful events and decisions
- references to commits, PRs, issues, reviews, and CI instead of duplicated GitHub facts

## Why Git

Git is a practical default for agent memory:

- Auditable: every memory change has a diff, author, timestamp, and commit history.
- Readable: memory stays as Markdown files that humans and agents can inspect without a special UI.
- Collaborative: multiple agents and humans can review, branch, merge, and roll back the same memory repo.
- Portable: a private remote lets the same memory follow you across machines and agent environments.
- Agent-native: coding agents are already connected to GitHub through MCP, CLIs, or local Git credentials, so Hippocamp does not need an external database, hosted dependency, or separate token setup.

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
events/YYYY-MM-DD.index.json
projects/<project-slug>/
  project.md
  current_state.md
  open_threads.md
  events/YYYY-MM-DD.md
  events/YYYY-MM-DD.index.json
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
3. Use `search_memory` for task-specific recall after wake-up.
4. Use `append_event` for meaningful milestones, with a title and 1-8 concise keywords.
5. Update curated files like `current_state.md` and `open_threads.md` before finishing.

Writes sync by default. If sync fails or is skipped, call `sync_memory`.

Event writes update a sibling `events/YYYY-MM-DD.index.json` file. The Markdown event remains the canonical memory; the sidecar is rebuildable. Search ranks indexed events and curated files with BM25 and typo tolerance ([MiniSearch](https://github.com/lucaong/minisearch)), weighting keywords above titles and titles above bodies. It returns small coherent evidence blocks from indexed events. If no indexed result is strong enough, it returns no event result instead of scanning whole event logs.

## Memory Rules

- Keep memory concise.
- Prefer curated summaries over raw event history.
- Give events a short `Keywords:` section; keywords weigh the most in search ranking. Older events with a `Cues:` section still search the same way.
- Do not duplicate GitHub-owned facts such as commits, PRs, issues, reviews, or CI results.
- Store artifact references plus the missing rationale, preference, assumption, or follow-up context.
- Use project scope for project-specific state.
- Use global scope only for durable context that should follow you across projects.

Events are stamped automatically with agent/session provenance when available (`Agent:` / `Session:` lines). Installers set `HIPPOCAMP_AGENT`; session defaults to a process-lifetime id. No manual config is required.

Example event content:

```md
Agent: claude
Session: mcp-a1b2c3d4

Keywords:
- local-first
- token-free
- install-story

References:
- commit: abc1234
- pr: #12

Decision:
Keep the local MCP path token-free and rely on normal git credentials.

Why:
This reduces onboarding friction for open-source users and avoids cloud auth concerns in the MVP.
```

## What This Is Not

- Not a hosted cloud service
- Not a database
- Not a notes app
- Not a vector store
- Not a queue

The cloud/API version can be redesigned later. The MVP is intentionally local-first and Git-native.
