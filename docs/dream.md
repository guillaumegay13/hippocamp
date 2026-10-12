# Dream

[← Back to README](../README.md)

Dream keeps project wake-up context current and compact. It rewrites only:

```text
projects/<project-slug>/current_state.md
projects/<project-slug>/open_threads.md
```

Dream runs when a project has new indexed events or its wake-up context exceeds `--threshold-chars`. It does not run during normal MCP wake-up or modify append-only events.

Each run reads a chronological batch of up to 20 new indexed event excerpts, independent of existing open threads. The first run starts with the last seven days. After a successful write, a small `<!-- hippocamp-dream-through: ... -->` comment in `current_state.md` records the last event included. Preserve this comment when editing the file. Later runs resume there, including after downtime; events after the last included event wait for the next run. If the first excerpt alone exceeds the recent-event budget, Dream fails without writing and asks for a larger `--target-chars`. If the comment is removed, Dream starts again with the last seven days.

Recent events use at most half of the evidence budget. The remaining budget supports searches for existing `open_threads.md` bullets. The total evidence budget follows `--target-chars`. The model receives bounded coherent excerpts with source paths and timestamps, never whole event logs or raw indexes.

Dream promotes clear decisions, explicit corrections, and reusable project lessons into `current_state.md`, with source references. It keeps remaining actions in `open_threads.md`, preserves unresolved blockers, and removes completed actions only when evidence supports it. A merged PR does not prove its deployment or follow-up work is done. Uncertain lessons remain in events for normal search.

Projects with indexed events can start without curated summaries. Dream creates the two files, and the scheduled runners include these new files in the project's PR.

Corrections apply across both files: a shipped feature should not remain an implementation task, while unverified deployment stays open. Extra compaction passes must keep source paths and timestamps for retained knowledge and aim below the size limit to leave room for length estimates. Dream writes the review comment itself; the model does not set review progress.

The snapshot may grow within `--target-chars` when new evidence adds useful knowledge. If it exceeds the target, Dream compacts the complete result again. It never crops a wake-up file. After three passes, it fails without writing either file or advancing the event comment if the snapshot still does not fit. A project below the threshold with no new indexed evidence is skipped without a model call.

Dry-run is the default:

```bash
npm run dream -- --all --dry-run --json
npm run dream -- --project my-project --write
```

`--write` requires a Manifest/OpenAI-compatible Responses API endpoint. The default environment variables are:

- `MANIFEST_BASE_URL`
- `MANIFEST_API_KEY`
- `HIPPOCAMP_DREAM_MODEL` (defaults to `auto`; override if you want a specific provider/model)

The GitHub Actions template at `assets/github-actions/hippocamp-dream.yml` is meant to be copied into the private Lagoon memory repo as `.github/workflows/hippocamp-dream.yml`. It runs on a schedule only, scans projects with new events or oversized wake-up context, and creates or updates one PR per project. With `HIPPOCAMP_DREAM_AUTO_MERGE=true`, Dream squash-merges the PR only when the repository name is `lagoon` and the PR changes only the two curated project files.

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
