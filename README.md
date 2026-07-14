# Hippocamp

<p align="center">
  <img src="./assets/brand/hippocamp-mascot.png" alt="Hippocamp mascot" width="220" />
</p>

Hippocamp is local Git-backed memory for AI coding agents.

Agents can edit large codebases, run tests, and push commits, but every new session still starts with amnesia. Project decisions, user preferences, open threads, and "why we did this" context get scattered across chat history, scratch notes, and PR comments. The result is repeated explanations, stale assumptions, and agents rediscovering the same facts instead of continuing the work.

Hippocamp gives Codex, Claude Code, and other MCP clients a small shared memory surface they can wake up from, update, and sync. The memory is plain Markdown in a private Git repo you own.

No database. No hosted memory service. No vector store. No separate token broker.

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

The repo should usually be private. Pushing memory to a private remote keeps it available across machines and agent environments while still using normal Git access controls. Hippocamp does not need a GitHub token for local MCP mode; it uses your normal local Git credentials.

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
3. Use `search_memory` only when wake-up files are not enough.
4. Use `append_event` for meaningful milestones, with concise cues when possible.
5. Update curated files like `current_state.md` and `open_threads.md` before finishing.

Writes sync by default. If sync fails or is skipped, call `sync_memory`.

Event writes update a sibling `events/YYYY-MM-DD.index.json` file. The Markdown event remains the canonical memory; the sidecar keeps cue-based fuzzy search fast and rebuildable.

## Dream

Dream is offline compaction for project wake-up context. It rewrites only:

```text
projects/<project-slug>/current_state.md
projects/<project-slug>/open_threads.md
```

It does not dump event logs into the model prompt, does not rewrite append-only events, and does not run during normal MCP wake-up. When a project is over the threshold, Dream builds a capped thread evidence pack by searching cue-indexed project events for `open_threads.md` bullets. The evidence budget follows `--target-chars`, so the same size target controls both the desired output and the supporting context. This gives the model enough context to keep, rewrite, close, or promote threads without loading raw history.

Dry-run is the default:

```bash
npm run dream -- --all --dry-run --json
npm run dream -- --project my-project --write
```

`--write` requires a Manifest/OpenAI-compatible Responses API endpoint. The default environment variables are:

- `MANIFEST_BASE_URL`
- `MANIFEST_API_KEY`
- `HIPPOCAMP_DREAM_MODEL` (defaults to `auto`; override if you want a specific provider/model)

The GitHub Actions template at `assets/github-actions/hippocamp-dream.yml` is meant to be copied into the private Lagoon memory repo as `.github/workflows/hippocamp-dream.yml`. It runs on a schedule only, scans projects over the wake-up threshold, and creates or updates one PR per project so each memory compaction is reviewable.

## Memory Rules

- Keep memory concise.
- Prefer curated summaries over raw event history.
- Give events a short `Cues:` section so fuzzy search can recall them without scanning full bodies first.
- Do not duplicate GitHub-owned facts such as commits, PRs, issues, reviews, or CI results.
- Store artifact references plus the missing rationale, preference, assumption, or follow-up context.
- Use project scope for project-specific state.
- Use global scope only for durable context that should follow you across projects.

Example event content:

```md
Cues:
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

## Commands

```bash
npm run mcp
npm run mcp:help
npm run mcp:smoke
npm run dream
npm run install:codex
npm run install:claude
npm run upgrade:codex
npm run upgrade:claude
```

## Releases

Pull requests and pushes to `main` run syntax and MCP smoke checks in GitHub Actions.

To publish a package version:

1. Update the version in `package.json` and `package-lock.json`, then merge it to `main`.
2. Publish a GitHub Release whose tag is `v<version>`.
3. The `Publish Package` workflow verifies the tag, runs the MCP checks, and publishes to npm through trusted publishing.

The npm package must trust the GitHub Actions workflow `publish.yml` in `guillaumegay13/hippocamp`. This uses short-lived OIDC credentials instead of an npm token.

## Configuration

Environment variables are optional for local use:

- `HIPPOCAMP_GLOBAL_ROOT`: local Lagoon clone path. Default: `~/.lagoon`
- `HIPPOCAMP_PROJECT_ROOT`: project root used to infer the current project slug. Default: current working directory
- Git worktrees, including Conductor workspaces, resolve to the main repository name so every workspace shares the same project memory.
- `MANIFEST_BASE_URL`: OpenAI-compatible base URL used by `hippocamp dream --write`
- `MANIFEST_API_KEY`: API key used by `hippocamp dream --write`
- `HIPPOCAMP_DREAM_MODEL`: model used by Dream. Default: `auto`
- `HIPPOCAMP_DREAM_THRESHOLD_CHARS`: wake-up size required before Dream proposes compaction. Default: `20000`
- `HIPPOCAMP_DREAM_TARGET_CHARS`: target combined size for `current_state.md` and `open_threads.md`. Default: `15000`

## What This Is Not

- Not a hosted cloud service
- Not a database
- Not a notes app
- Not a vector store
- Not a queue

The cloud/API version can be redesigned later. The MVP is intentionally local-first and Git-native.
