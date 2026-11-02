# Development

[← Back to README](../README.md)

## Commands

```bash
npm run mcp
npm run mcp:help
npm run mcp:smoke
npm run dream
npm run dream:railway
npm run eval:continuity
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

## Work continuity benchmark

`npm run eval:continuity` measures what Hippocamp is built for: a coding agent that keeps working on a project across independent sessions and acts on earlier decisions, constraints and state without being told to look them up.

- The dataset in `bench/continuity/` is synthetic: two small engineering projects (`relay`, a TypeScript webhook relay, and `ingest`, a Python CSV pipeline) on one 21-session timeline. Work sessions are ordinary tickets that plant facts; probe sessions are ordinary tickets with hidden checklists. No prompt hints at retrieval.
- Arms, each set up the way a developer has it: `cc-none` (auto-memory off), `cc-native` (Claude Code defaults) and `cc-hippocamp` (Hippocamp through its real installer, auto-memory off).
- Each session is a fresh headless `claude -p --model claude-opus-5-5` process. The repo is committed after each session with the agent's own summary as the message. If the agent ends with an offer or a question, the simulated user answers once with "yes, go ahead". A retried session restores both the repo and the memory store.
- Sandboxes live in `HIPPOCAMP_BENCH_DIR` (default `~/.cache/hippocamp-bench`), each with its own `HOME` and `CLAUDE_CONFIG_DIR`, so your real `~/.claude` and `~/.lagoon` are never read or written, and runs survive reboots.
- Judging: a blind judge grades each check from the diff and a tool log with memory tools and paths anonymized. A second call explains each miss (never stored, stale memory, wrong scope, not recalled, ignored, asked instead of acting). At the end, a third grades every stored memory entry for coverage, precision, staleness, noise and duplicates. Prompts and replies are kept next to each transcript, and `validation.csv` lists every verdict for hand-checking.
- Each session records tokens, time, memory tool calls and memory bytes read or auto-loaded.

```bash
npm run eval:continuity -- --dry-run                                         # free: validates and prints the cost range
npm run eval:continuity -- --systems cc-native,cc-hippocamp --limit 3 --run smoke
npm run eval:continuity -- --run final-1                                     # full run
npm run eval:continuity -- --report final-1,final-2                          # pooled report, spawns nothing
```

Sessions and the Claude judge run through Claude Code, so they use your Claude subscription when `CLAUDE_CODE_OAUTH_TOKEN` is set (create it with `claude setup-token` and put it in `.env`). Without it they bill `ANTHROPIC_API_KEY`. `--dry-run` prints the API-price range, and `--budget` caps each call. Results go to `.context/continuity/<run>/`. A run is frozen by `manifest.json` (dataset, harness, model and Claude Code version): reruns with the same `--run` skip finished sessions, new sessions appended to the timeline extend it, and any frozen change is refused unless `--force-manifest` records it. The report shows n next to every percentage, defines memory-required items as those `cc-none` fails in every run, and gives bootstrap intervals over probes.

## Releases

Pull requests and pushes to `main` run syntax and MCP smoke checks in GitHub Actions.

To publish a package version:

1. Update the version in `package.json` and `package-lock.json`, then merge it to `main`.
2. Publish a GitHub Release whose tag is `v<version>`.
3. The `Publish Package` workflow verifies the tag, runs the MCP checks, and publishes to npm through trusted publishing.

The npm package must trust the GitHub Actions workflow `publish.yml` in `guillaumegay13/hippocamp`. This uses short-lived OIDC credentials instead of an npm token.
