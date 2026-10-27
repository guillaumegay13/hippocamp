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

- The dataset in `bench/continuity/` is synthetic: two small engineering projects (`relay`, a TypeScript webhook relay, and `ingest`, a Python CSV pipeline) run as one 21-session timeline that shares one memory store.
- Work sessions are ordinary tickets that plant 26 facts, three of which are later reversed. Some facts leave no trace in the code: a smoke-test recipe, a blocker, work parked on a branch, a preference that spans both projects. Two filler sessions plant nothing. Seven probe sessions are also ordinary tickets, with hidden checklists. No prompt hints at retrieval; the validator rejects words such as "remember" or "your notes".
- Each session is a fresh headless `claude -p --model claude-opus-5-5` process. Follow-up turns resume the same session, and the repo is committed after each session.
- Systems: `none` (the repo only), `native` (Claude Code auto-memory) and `hippocamp` (Hippocamp MCP on a throwaway Lagoon).
- Every run is isolated: sandboxes live under the OS temp dir with their own `HOME`, `CLAUDE_CONFIG_DIR` and Lagoon, so your real `~/.claude` and `~/.lagoon` are never read or written.
- A judge model grades each checklist item from the diff, the tool calls and the memory available at the start of the probe. It labels misses as never stored, stored but not recalled, or recalled but ignored.

```bash
npm run eval:continuity -- --dry-run                                   # free: validates and prints the cost range
npm run eval:continuity -- --systems hippocamp --limit 2 --run smoke   # small paid check
npm run eval:continuity -- --run v1                                    # full run
```

Sessions and the Claude judge run through Claude Code, so they use your Claude subscription when `CLAUDE_CODE_OAUTH_TOKEN` is set (create it with `claude setup-token` and put it in `.env`). Without it they bill `ANTHROPIC_API_KEY`. A full run starts 63 Opus sessions, a large share of a subscription's usage window: `--dry-run` prints the API-price range, and `--budget` caps each call. Results go to `.context/continuity/<run>/`, and reruns with the same `--run` skip finished sessions. New sessions appended to the timeline extend an existing run without redoing it; a recorded session whose prompts or checks changed is refused, so start a new `--run` for that.

## Releases

Pull requests and pushes to `main` run syntax and MCP smoke checks in GitHub Actions.

To publish a package version:

1. Update the version in `package.json` and `package-lock.json`, then merge it to `main`.
2. Publish a GitHub Release whose tag is `v<version>`.
3. The `Publish Package` workflow verifies the tag, runs the MCP checks, and publishes to npm through trusted publishing.

The npm package must trust the GitHub Actions workflow `publish.yml` in `guillaumegay13/hippocamp`. This uses short-lived OIDC credentials instead of an npm token.
