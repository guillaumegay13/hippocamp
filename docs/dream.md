# Dream

[← Back to README](../README.md)

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

## Railway

Railway can run Dream overnight even when your computer is offline. The included cron service starts once per day at `03:17 UTC`, clones the private Lagoon repo, creates or updates one Dream PR per candidate project, and exits. Set `HIPPOCAMP_DREAM_AUTO_MERGE=true` to enable the same Lagoon-only auto-merge policy.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hippocamp)

Required template variables:

- `LAGOON_REPOSITORY`: private memory repo in `owner/repository` form
- `GITHUB_TOKEN`: fine-grained GitHub token limited to that repo, with read/write access to Contents and Pull requests
- `MANIFEST_BASE_URL`: Manifest/OpenAI-compatible base URL
- `MANIFEST_API_KEY`: API key for Dream model requests

Optional variables keep the CLI defaults: `HIPPOCAMP_DREAM_MODEL=auto`, `HIPPOCAMP_DREAM_THRESHOLD_CHARS=20000`, and `HIPPOCAMP_DREAM_TARGET_CHARS=15000`. `HIPPOCAMP_DREAM_AUTO_MERGE=true` enables a guarded squash merge for a repository named `lagoon`.

Railway is an optional deployment target. Local MCP reads and writes do not use Railway or require these hosted credentials.
