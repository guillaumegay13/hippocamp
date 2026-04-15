# AGENTS.md

This repository is a local-first MCP package for Git-backed agent memory. Keep changes narrow, explicit, and easy to verify.

## Purpose

- The product stores agent memory as Markdown files in a local Git repo, usually `~/.lagoon`.
- The local Git repo syncs to GitHub through the user's normal Git credentials.
- The app is intentionally not a database, notes app, queue, vector store, cloud API, or auth broker.
- MVP primitives are:
  - `events/`
  - `projects/<slug>/`
  - curated root Markdown files such as `identity.md` and `preferences.md`

## Stack

- Node.js CommonJS scripts
- MCP stdio server
- Local filesystem reads and writes
- Git CLI for commit/push sync

## Repository Map

- `scripts/hippocamp.cjs`: small CLI wrapper for `mcp`, `install-codex`, and `install-claude`.
- `scripts/hippocamp-memory.cjs`: local filesystem-backed Hippocamp memory helpers for MCP use.
- `scripts/hippocamp-mcp.cjs`: local stdio MCP server for Hippocamp memory tools.
- `scripts/install-claude.cjs`: one-step installer for Claude Code MCP setup and user-level `CLAUDE.md` guidance.
- `scripts/install-codex.cjs`: one-step installer for the Hippocamp skill and MCP server in Codex.
- `skills/hippocamp-memory/SKILL.md`: installable skill that tells agents how to use Hippocamp memory.
- `assets/brand/hippocamp-mascot.png`: README mascot asset.

## Project Invariants

- Memory paths must stay under the selected Lagoon memory root.
- Sync paths must stay under the selected Lagoon memory root.
- Global memory lives under `HIPPOCAMP_GLOBAL_ROOT/`.
- Project memory lives under `HIPPOCAMP_GLOBAL_ROOT/projects/<slug>/`.
- The current project slug is inferred from `HIPPOCAMP_PROJECT_ROOT` or the current working directory.
- Event logs are append-only daily Markdown files under `events/YYYY-MM-DD.md`.
- Curated files such as `current_state.md` and `open_threads.md` use explicit file writes.
- Default sync is automatic through the local Lagoon repo.
- Local MCP mode must not require `GITHUB_TOKEN`, GitHub App auth, or a cloud service.
- Memory must not duplicate facts already tracked by GitHub commits, PRs, issues, reviews, or CI. Store references plus the missing rationale, preference, assumption, or follow-up context instead.

## Change Rules

- Follow the existing style and keep changes surgical.
- Do not add abstractions, config knobs, or new subsystems unless the task explicitly requires them.
- If behavior changes, update `README.md` and this file only when operational guidance actually changes.
- Prefer extending `scripts/hippocamp-memory.cjs` over duplicating path, sync, or search logic.
- Keep the product narrow. Simpler is better in this repo.

## Verification

When changing code, use the smallest verification that proves the change:

- Run `node --check scripts/*.cjs` for script syntax changes.
- Run `npm run mcp:help` when changing MCP registration or commands.
- Run `npm run mcp:smoke` when changing memory reads, root resolution, or wake-up behavior.
- There is no dedicated test suite yet, so do not claim test coverage that does not exist.

## Notes For Future Agents

- The cloud/API version is intentionally deferred.
- Do not reintroduce Next.js, GitHub API token auth, or GitHub App auth for the local MVP.
- Dream PRs, branch-per-agent workflows, and automatic compaction should be designed later as a separate feature.
- The local install story should stay: install MCP, point at Lagoon, rely on normal Git auth.
