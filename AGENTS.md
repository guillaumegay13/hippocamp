# AGENTS.md

This repository is a small Next.js service for Git-backed shared memory. Keep changes narrow, explicit, and easy to verify.

## Purpose

- The product stores agent memory as Markdown files in a GitHub repository.
- The app is intentionally not a database, notes app, queue, or vector store.
- V1 primitives are only:
  - `.hippocamp/events/`
  - `.hippocamp/agents/`
  - `.hippocamp/shared/`

## Stack

- Next.js App Router
- TypeScript
- GitHub Contents API as the storage backend
- Vercel deployment target

## Required Environment

These environment variables must exist for write and read paths to work:

- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH`

Configuration is loaded in `lib/config.ts`.

## Repository Map

- `app/api/**/route.ts`: thin route handlers; keep request parsing and response shaping here.
- `lib/memory.ts`: memory path validation, agent name sanitization, event formatting, default file shapes, and search helpers.
- `lib/github.ts`: all GitHub reads and writes, including stale-SHA retry behavior.
- `lib/http.ts`: shared JSON error responses.
- `lib/types.ts`: shared domain types.
- `scripts/hippocamp-memory.cjs`: local filesystem-backed Hippocamp memory helpers for MCP use.
- `scripts/hippocamp-mcp.cjs`: local stdio MCP server for Hippocamp memory tools.
- `scripts/install-claude.cjs`: one-step installer for Claude Code MCP setup and user-level `CLAUDE.md` guidance.
- `scripts/install-codex.cjs`: one-step installer for the Hippocamp skill and MCP server in Codex.
- `skills/hippocamp-memory/SKILL.md`: installable skill that tells agents how to use Hippocamp memory.
- `app/page.tsx`: minimal landing page describing the API surface.

## Project Invariants

- Memory paths must stay under `.hippocamp/`.
- Sync paths must stay under the selected `.hippocamp/` root.
- Agent names may only contain letters, numbers, dots, underscores, and hyphens.
- Event logs are append-only daily Markdown files under `.hippocamp/events/YYYY-MM-DD.md`.
- Agent state lives in isolated files under `.hippocamp/agents/{agent}.md`.
- Shared files live under `.hippocamp/shared/` and use explicit file writes.
- Memory must not duplicate facts already tracked by GitHub commits, PRs, issues, reviews, or CI. Store references plus the missing rationale, preference, assumption, or follow-up context instead.
- Route handlers should stay thin; shared behavior belongs in `lib/*`.
- Reuse `lib/github.ts` for GitHub access instead of adding ad hoc `fetch` calls in routes.
- The local MCP server uses `HIPPOCAMP_GLOBAL_ROOT/.hippocamp/` for global memory and `HIPPOCAMP_GLOBAL_ROOT/.hippocamp/projects/<slug>/` for per-project personal memory.
- The current project slug is inferred from `HIPPOCAMP_PROJECT_ROOT` or the current working directory.
- Default sync is automatic through the Lagoon repo for both global memory and per-project personal memory.

## Change Rules

- Follow the existing style and keep changes surgical.
- Do not add abstractions, config knobs, or new subsystems unless the task explicitly requires them.
- If behavior changes, update `README.md` and this file only when the operational guidance actually changes.
- Prefer extending existing helpers over duplicating validation or formatting logic in route files.
- Preserve the current error contract built around `AppError` and `toErrorResponse`.

## Verification

When changing code, use the smallest verification that proves the change:

- Run `npm run typecheck` for TypeScript changes.
- Run `npm run build` when changing routing, server behavior, or framework configuration.
- There is no dedicated test suite yet, so do not claim test coverage that does not exist.

## Notes For Future Agents

- `lib/memory.ts` defines the Markdown file formats. Keep those formats stable unless the API contract is intentionally changing.
- `lib/github.ts` already handles stale SHA retries for writes. Reuse that path before inventing new conflict handling.
- Keep the product narrow. Simpler is better in this repo.
