---
name: hippocamp-memory
description: Use Hippocamp memory to load global identity and workflow context from the Lagoon clone and project context from the Lagoon projects folder. Trigger this at the start of top-level task threads, when you need durable memory recall, or when you need to checkpoint meaningful progress.
---

# Hippocamp Memory

Use this skill when the user wants persistent memory across agent sessions.

This same skill can be installed into Codex, Claude Code, or Grok Build.
For Codex, use `npm run install:codex`; that installer copies this skill into `~/.codex/skills/hippocamp-memory/`, registers the Hippocamp MCP server, and refreshes `~/.codex/AGENTS.md`.
For Claude Code, use `npm run install:claude`; that installer copies this skill into `~/.claude/skills/hippocamp-memory/`, registers the Hippocamp MCP server, and refreshes `~/.claude/CLAUDE.md`.
For Grok Build, use `npm run install:grok`; that installer copies this skill into `~/.grok/skills/hippocamp-memory/`, registers the Hippocamp MCP server with `HIPPOCAMP_AGENT=grok`, and refreshes `~/.grok/rules/hippocamp.md`.
Upgrade uses the same path: run `npm run upgrade:codex`, `npm run upgrade:claude`, or `npm run upgrade:grok` from a source checkout, or `npx hippocamp@latest upgrade-codex` / `upgrade-claude` / `upgrade-grok` after publishing.

## Scope

- Global memory lives at the root of the local Lagoon clone pointed to by `HIPPOCAMP_GLOBAL_ROOT`.
- Project memory lives under `projects/<slug>/` inside that same Lagoon clone.
- The current project slug is inferred from `HIPPOCAMP_PROJECT_ROOT` or the current working directory.
- The Hippocamp MCP server exposes the tools that read and write those locations.

## Default Workflow

1. At the start of every top-level coding task, call `wake_up` before inspecting files, planning, or editing.
2. Read the wake-up output before searching.
3. Only call `search_memory` if the wake-up files are insufficient.
4. During work, use `append_event` only for meaningful milestones.
5. When appending events, include concise `Cues:` values or pass the `cues` argument so fuzzy recall can find the event later.
6. `write_memory_file` and `append_event` sync by default.
7. If a sync is skipped or fails, call `sync_memory` explicitly.
8. At the end of the task, use `write_memory_file` to update curated files such as:
   - `current_state.md`
   - `open_threads.md`
   - `identity.md`
   - `how_i_work.md`
   - `preferences.md`

## Behavior Rules

- Do not full-scan memory on every thread.
- Prefer curated summaries over raw event history.
- Use event cues as short recall handles; `search_memory` fuzzy-ranks cues and headings before reading matching event bodies.
- Keep curated files short and legible.
- Do not duplicate GitHub-owned facts such as commits, PRs, issues, reviews, or CI results. Store artifact references plus the missing rationale, preference, assumption, or follow-up context.
- Use `project` scope for project-specific state.
- Use `global` scope only for durable personal context that should follow the user across projects.
- Avoid rewriting unrelated memory files.
- Treat `sync_memory` as the recovery path when default sync cannot safely proceed.

## Suggested Files

Global:

- `identity.md`
- `how_i_work.md`
- `preferences.md`
- `open_loops.md`

Project:

- `project.md`
- `current_state.md`
- `open_threads.md`
- `events/YYYY-MM-DD.md`
- `events/YYYY-MM-DD.index.json`

## Tooling

Expected MCP tools:

- `wake_up`
- `read_memory_file`
- `write_memory_file`
- `append_event`
- `list_memory_files`
- `search_memory`
- `sync_memory`
