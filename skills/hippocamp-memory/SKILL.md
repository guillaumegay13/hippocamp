---
name: hippocamp-memory
description: Use Hippocamp memory to load global identity and workflow context from the Lagoon clone and project context from a repo's .hippocamp folder. Trigger this at the start of top-level task threads, when you need durable memory recall, or when you need to checkpoint meaningful progress.
---

# Hippocamp Memory

Use this skill when the user wants persistent memory across agent sessions.

This same skill can be installed into Codex or Claude Code.
For Claude Code, use `npm run install:claude`; that installer copies this skill into `~/.claude/skills/hippocamp-memory/`, registers the Hippocamp MCP server, and refreshes `~/.claude/CLAUDE.md`.

## Scope

- Global memory lives in the `.hippocamp/` folder inside the local Lagoon clone pointed to by `HIPPOCAMP_GLOBAL_ROOT`.
- Project memory lives under `.hippocamp/projects/<slug>/` inside that same Lagoon clone.
- The current project slug is inferred from `HIPPOCAMP_PROJECT_ROOT` or the current working directory.
- The Hippocamp MCP server exposes the tools that read and write those locations.

## Default Workflow

1. At the start of a top-level thread, call `wake_up`.
2. Read the wake-up output before searching.
3. Only call `search_memory` if the wake-up files are insufficient.
4. During work, use `append_event` only for meaningful milestones.
5. `write_memory_file` and `append_event` sync by default.
6. If a sync is skipped or fails, call `sync_memory` explicitly.
7. At the end of the task, use `write_memory_file` to update curated files such as:
   - `current_state.md`
   - `open_threads.md`
   - `identity.md`
   - `how_i_work.md`
   - `preferences.md`

## Behavior Rules

- Do not full-scan memory on every thread.
- Prefer curated summaries over raw event history.
- Keep curated files short and legible.
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

## Tooling

Expected MCP tools:

- `wake_up`
- `read_memory_file`
- `write_memory_file`
- `append_event`
- `list_memory_files`
- `search_memory`
- `sync_memory`
