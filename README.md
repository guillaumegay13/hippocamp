# Hippocamp

[![CI](https://github.com/guillaumegay13/hippocamp/actions/workflows/ci.yml/badge.svg)](https://github.com/guillaumegay13/hippocamp/actions/workflows/ci.yml)

<p align="center">
  <img src="./assets/brand/hippocamp-mascot.png" alt="Hippocamp mascot" width="220" />
</p>

Agent memory you can `git log`.

Hippocamp gives all your coding agents, like Claude Code and Codex, one shared memory: plain Markdown in a private Git repo you own. Every session starts by waking up from it, and every decision an agent records is a commit you can read, diff, and revert.

Open source (MIT). No account, no API key, no Hippocamp server: it runs on your machine and works the moment it is installed. Your memory lives in a Git repo you control, on your machine and on the remote you pick, such as a private GitHub repo. No database, no vector store, nothing to pay for.

```bash
npx hippocamp@latest install
```

This installs Hippocamp into every supported agent CLI it finds, creates `~/.lagoon` as a local Git repo if it does not exist, and tells you how to add a private remote. Restart your agent, and it calls `wake_up` at the start of each task.

## Why Not Built-In Memory?

Claude Code and Codex now ship their own memory. Use Hippocamp when you want:

- **One memory for every agent.** Claude Code, Codex, and your other agents read and write the same repo. Built-in memory stays inside one tool.
- **History you can audit.** Every memory change is a Git commit with an author, a diff, and a timestamp. Roll back a bad memory like bad code.
- **Files you own.** Markdown in your own private repo, readable without any UI, portable across machines through your normal Git credentials.
- **Nothing to sign up for.** Open source and free, running on your machine. No account, no API key, no vendor that can change terms or shut down.
- **Reviewed compaction.** Optional Dream mode summarizes memory offline and proposes the result as a pull request.

## Results

Every number below comes from a script in this repo, so you can rerun it. We report where Hippocamp falls short too.

### Finding the right memory

LongMemEval-S, all 470 answerable questions, top 5 results, no model involved (`npm run eval:retrieval`).

| Measure | Hippocamp | BM25 reference |
| --- | ---: | ---: |
| Right session in top 5 (Recall@5) | 90.5% | 91.4% |
| At least one right session in top 5 (Hit@5) | 96.0% | 96.8% |
| Returned text contains the answer turn | 87.9% | n/a |
| Text returned per query | 5.9k chars | 65.5k chars |
| Search latency, cold index | 42 ms | n/a |

BM25 returns whole sessions; Hippocamp returns the matching paragraphs of each result.

### Answering with it

100 LongMemEval-S questions, reader Claude Sonnet 5, grader gpt-4o with the official LongMemEval grading prompts (`npm run eval:qa`).

| What the reader gets | Text per question | Answer accuracy |
| --- | ---: | ---: |
| Hippocamp, top 5 | 6.7k chars | 71% |
| Hippocamp, top 10 | 12.9k chars | 77% |
| The correct sessions, given directly | 28.8k chars | 90% |

The same reader reaches 90% with the correct sessions, so the remaining gap is retrieval, not the reader.

### Real coding questions

53 questions about real work in a personal Lagoon across 13 projects (`npm run eval:lagoon`). This is our own test set, kept in the private Lagoon.

| Measure | Result |
| --- | ---: |
| Right event in top 5, 43 answerable questions | 42 / 43 |
| No results for 10 questions no memory is about | 10 / 10 |

### Why less text matters

Memory results share the agent's context with code, diffs, and tool output, and agents search several times per task. About 6k characters per search is roughly 1.5k tokens; whole sessions would be about 16k. Fewer tokens make each turn cheaper and faster, and keep the relevant lines from being buried. Less text is only useful when the answer is still in it, which is why we report answer accuracy next to text size.

### Limits

- Recall@5 is just under the BM25 reference, by less than 1 point, with 11 times less text.
- No embeddings or semantic search: a memory written in other words can be missed. On LongMemEval-S, 9 of 470 questions miss with no word in common with the answer.
- Answer accuracy is measured on 100 questions, about plus or minus 4 points.
- Self-reported scores from other memory systems use their own readers and graders, so they are not directly comparable with these.

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

```bash
npx hippocamp@latest install
```

To install into one agent only:

```bash
npx hippocamp@latest install-claude
npx hippocamp@latest install-codex
npx hippocamp@latest install-grok
```

Upgrade with the same command: `npx hippocamp@latest upgrade`. Installers default to `~/.lagoon` as the memory repo; pass `--global-root /absolute/path/to/lagoon` to use another clone.

Installed through npx, the agent starts the server with `npx -y --prefer-offline hippocamp@<version> mcp`, so it keeps working if npm cleans its cache. From a source checkout, `npm install` then `npm run install:claude` (or `install:codex`, `install:grok`) registers the checkout directly.

The Codex installer refreshes `~/.codex/AGENTS.md`. The Claude installer refreshes `~/.claude/CLAUDE.md`. The Grok installer refreshes `~/.grok/rules/hippocamp.md` and registers the MCP server with `HIPPOCAMP_AGENT=grok`.
Managed instruction blocks tell the agent to call `wake_up` at the start of new top-level coding tasks before repo exploration or edits.

## Lagoon Repo

Hippocamp keeps memory in a local Git repo. The installer creates `~/.lagoon` if it is missing. To use memory you already have on another machine, clone it first:

```bash
git clone git@github.com:YOUR_USER/lagoon.git ~/.lagoon
```

The repo should usually be private. Pushing memory to a private remote keeps it available across machines and agent environments while still using normal Git access controls. Hippocamp does not need a GitHub token for local MCP mode; it uses your normal local Git credentials.

Memory works locally without a remote. To back it up privately and share it across machines, create a private remote:

```bash
gh repo create lagoon --private --source ~/.lagoon --remote origin --push
```

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
3. Use `search_memory` for task-specific recall after wake-up.
4. Use `append_event` for meaningful milestones, with a title and 1-8 concise cues.
5. Update curated files like `current_state.md` and `open_threads.md` before finishing.

Writes sync by default. If sync fails or is skipped, call `sync_memory`.

Event writes update a sibling `events/YYYY-MM-DD.index.json` file. The Markdown event remains the canonical memory; the sidecar is rebuildable. Search ranks indexed events and curated files with BM25 and typo tolerance ([MiniSearch](https://github.com/lucaong/minisearch)), weighting cues above titles and titles above bodies. It returns small coherent evidence blocks from indexed events. If no indexed result is strong enough, it returns no event result instead of scanning whole event logs.

## Dream

Dream is offline compaction for project wake-up context. It rewrites only:

```text
projects/<project-slug>/current_state.md
projects/<project-slug>/open_threads.md
```

It does not dump event logs into the model prompt, does not rewrite append-only events, and does not run during normal MCP wake-up. When a project is over the threshold, Dream builds a capped thread evidence pack by searching cue-indexed project events for `open_threads.md` bullets. The evidence budget follows `--target-chars`, so the same size target controls both the desired output and the supporting context.

Dream uses an Eve-style compaction loop. It rewrites the complete curated snapshot, measures the result, and compacts that coherent result again when it is still over the target. It never crops a wake-up file. After three passes, it fails without writing either file if the snapshot still does not fit.

Dry-run is the default:

```bash
npm run dream -- --all --dry-run --json
npm run dream -- --project my-project --write
```

`--write` requires a Manifest/OpenAI-compatible Responses API endpoint. The default environment variables are:

- `MANIFEST_BASE_URL`
- `MANIFEST_API_KEY`
- `HIPPOCAMP_DREAM_MODEL` (defaults to `auto`; override if you want a specific provider/model)

The GitHub Actions template at `assets/github-actions/hippocamp-dream.yml` is meant to be copied into the private Lagoon memory repo as `.github/workflows/hippocamp-dream.yml`. It runs on a schedule only, scans projects over the wake-up threshold, and creates or updates one PR per project. With `HIPPOCAMP_DREAM_AUTO_MERGE=true`, Dream squash-merges the PR only when the repository name is `lagoon` and the PR changes only the two curated project files.

### Railway

Railway can run Dream overnight even when your computer is offline. The included cron service starts once per day at `03:17 UTC`, clones the private Lagoon repo, creates or updates one Dream PR per candidate project, and exits. Set `HIPPOCAMP_DREAM_AUTO_MERGE=true` to enable the same Lagoon-only auto-merge policy.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hippocamp)

Required template variables:

- `LAGOON_REPOSITORY`: private memory repo in `owner/repository` form
- `GITHUB_TOKEN`: fine-grained GitHub token limited to that repo, with read/write access to Contents and Pull requests
- `MANIFEST_BASE_URL`: Manifest/OpenAI-compatible base URL
- `MANIFEST_API_KEY`: API key for Dream model requests

Optional variables keep the CLI defaults: `HIPPOCAMP_DREAM_MODEL=auto`, `HIPPOCAMP_DREAM_THRESHOLD_CHARS=20000`, and `HIPPOCAMP_DREAM_TARGET_CHARS=15000`. `HIPPOCAMP_DREAM_AUTO_MERGE=true` enables a guarded squash merge for a repository named `lagoon`.

Railway is an optional deployment target. Local MCP reads and writes do not use Railway or require these hosted credentials.

## Memory Rules

- Keep memory concise.
- Prefer curated summaries over raw event history.
- Give events a short `Cues:` section; cues weigh the most in search ranking.
- Do not duplicate GitHub-owned facts such as commits, PRs, issues, reviews, or CI results.
- Store artifact references plus the missing rationale, preference, assumption, or follow-up context.
- Use project scope for project-specific state.
- Use global scope only for durable context that should follow you across projects.

Events are stamped automatically with agent/session provenance when available (`Agent:` / `Session:` lines). Installers set `HIPPOCAMP_AGENT`; session defaults to a process-lifetime id. No manual config is required.

Example event content:

```md
Agent: claude
Session: mcp-a1b2c3d4

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
npm run dream:railway
npm run eval:lagoon
npm run eval:qa
npm run eval:retrieval
npm run install:codex
npm run install:claude
npm run install:grok
npm run upgrade:codex
npm run upgrade:claude
npm run upgrade:grok
```

`npm run eval:retrieval` measures search on LongMemEval-S without any model: Recall@5, Hit@5, MRR, snippet evidence (the returned text comes from an answer turn), returned context size, and latency, next to an in-process BM25 reference. Run it with `--help` for the one-time data download.

`npm run eval:lagoon` runs the same kind of check, read-only, against your real Lagoon. It reads cases from `<Lagoon root>/evals/retrieval-cases.json`: a project, a query, and the event ids that answer it. An empty list means no memory should be returned. Keep the cases in Lagoon, not in this repo, because they quote private work.

`npm run eval:qa` measures answer accuracy on the same LongMemEval-S data with the official LongMemEval reader and grader prompts. It compares Hippocamp top 5 (`hippocamp`), top 10 (`hippocamp-k10`), and the labeled answer sessions (`oracle`). It calls an OpenAI-compatible endpoint from `MANIFEST_BASE_URL` and `MANIFEST_API_KEY`; set `QA_READER_MODEL` and `QA_GRADER_MODEL` to change models. Results are cached in `.context/qa-results.jsonl`, and `--dry-run` shows the jobs and token estimates without any API call.

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
- `HIPPOCAMP_DREAM_AUTO_MERGE`: set to `true` for a guarded squash merge in a repository named `lagoon`

## What This Is Not

- Not a hosted cloud service
- Not a database
- Not a notes app
- Not a vector store
- Not a queue

The cloud/API version can be redesigned later. The MVP is intentionally local-first and Git-native.
