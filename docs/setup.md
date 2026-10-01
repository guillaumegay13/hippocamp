# Setup

[← Back to README](../README.md)

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

Installed through npx, the installer copies the package to `~/.hippocamp/<version>/` and registers that copy, so the server starts without npx or network and keeps working if npm cleans its cache. From a source checkout, `npm install` then `npm run install:claude` (or `install:codex`, `install:grok`) registers the checkout directly.

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
