# Hippocamp

[![npm](https://img.shields.io/npm/v/hippocamp)](https://www.npmjs.com/package/hippocamp) [![CI](https://github.com/guillaumegay13/hippocamp/actions/workflows/ci.yml/badge.svg)](https://github.com/guillaumegay13/hippocamp/actions/workflows/ci.yml)

<p align="center">
  <img src="./assets/brand/hippocamp-mascot.png" alt="Hippocamp mascot" width="220" />
</p>

Agent memory you can read.

Hippocamp gives all your coding agents, like Claude Code and Codex, one shared memory: plain Markdown in a private Git repo you own. Every session starts by waking up from it, and every decision an agent records is a commit you can read, diff, and revert.

Open source (MIT). No account, no API key, no Hippocamp server. No database, no vector store, nothing to pay for.

```bash
npx hippocamp@latest install
```

This installs Hippocamp into every supported agent it finds and creates your memory repo, `~/.lagoon`. Restart your agent and it starts each task by waking up from memory.

![Codex saves a team decision to Hippocamp on its own; a later Claude Code session finds it with search_memory; git log shows the commit](https://raw.githubusercontent.com/guillaumegay13/hippocamp/main/assets/brand/hippocamp-demo.gif)

A replay of a real session. Neither prompt mentions Hippocamp.

## Why Hippocamp?

- **Written by the agent itself.** The agent doing the work decides what is worth keeping, in its own words. Unlike memory services that run a second model to extract facts, nothing rewrites it, so what you read is exactly what was saved.
- **One memory for every agent.** Claude Code, Codex, and your other agents share the same repo. Built-in memory, like Claude Code's or Codex's, stays inside one tool.
- **History you can audit.** Every memory is a Git commit. Roll back a bad memory like bad code.
- **Files you own.** Plain Markdown, readable without any UI, synced across machines with your normal Git credentials.
- **Nothing to sign up for.** No vendor that can change terms or shut down.

## Results

Reproducible with the scripts in this repo.

| | Hippocamp | Reference |
| --- | ---: | ---: |
| Right memory in top 5, LongMemEval-S (470 questions) | 90.5% | BM25: 91.4% |
| Text returned per search | 5.9k chars | Whole sessions: 65.5k |
| Answer accuracy, Claude Sonnet 5, top 10 results | 77% | Correct sessions given directly: 90% |
| Unrelated questions that return nothing (our own test set) | 10 / 10 | |

Full tables, method, and limits: [docs/results.md](docs/results.md).

## Docs

- [Setup](docs/setup.md): install options, the Lagoon repo, a private remote, configuration
- [How it works](docs/how-it-works.md): memory layout, MCP tools, memory rules
- [Dream](docs/dream.md): optional overnight compaction as a reviewed pull request
- [Results](docs/results.md): evals and how to rerun them
- [Development](docs/development.md): commands and releases

## License

MIT
