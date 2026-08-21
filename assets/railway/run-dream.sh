#!/usr/bin/env bash

set -euo pipefail

required=(
  GITHUB_TOKEN
  LAGOON_REPOSITORY
  MANIFEST_API_KEY
  MANIFEST_BASE_URL
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
done

if [[ ! "$LAGOON_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "LAGOON_REPOSITORY must use the owner/repository form." >&2
  exit 1
fi

export GH_TOKEN="$GITHUB_TOKEN"
export HIPPOCAMP_DREAM_MODEL="${HIPPOCAMP_DREAM_MODEL:-auto}"
export HIPPOCAMP_DREAM_TARGET_CHARS="${HIPPOCAMP_DREAM_TARGET_CHARS:-15000}"
export HIPPOCAMP_DREAM_THRESHOLD_CHARS="${HIPPOCAMP_DREAM_THRESHOLD_CHARS:-20000}"

runner_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_root="$(mktemp -d)"
lagoon_root="$work_root/lagoon"

cleanup() {
  rm -rf "$work_root"
}

trap cleanup EXIT

gh auth setup-git
gh repo clone "$LAGOON_REPOSITORY" "$lagoon_root"

cd "$lagoon_root"
git config user.name "${HIPPOCAMP_DREAM_GIT_NAME:-hippocamp-dream[bot]}"
git config user.email "${HIPPOCAMP_DREAM_GIT_EMAIL:-hippocamp-dream[bot]@users.noreply.github.com}"

export HIPPOCAMP_GLOBAL_ROOT="$lagoon_root"

node "$runner_root/scripts/hippocamp-dream.cjs" \
  --all \
  --dry-run \
  --json \
  --threshold-chars "$HIPPOCAMP_DREAM_THRESHOLD_CHARS" \
  > "$work_root/scan.json"

node - "$work_root/scan.json" > "$work_root/projects.txt" <<'NODE'
const fs = require("node:fs");
const scan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const projects = scan.results
  .filter((item) => item.skipped === "dry_run")
  .map((item) => item.project);
process.stdout.write(`${projects.join("\n")}${projects.length ? "\n" : ""}`);
console.error(`Dream candidates: ${projects.length ? projects.join(", ") : "none"}`);
NODE

failed=()

while IFS= read -r project; do
  [[ -n "$project" ]] || continue

  branch="dream/${project}"
  result_file="$work_root/${project}.json"
  body_file="$work_root/${project}.md"

  git fetch origin main
  git checkout -B "$branch" origin/main

  if ! node "$runner_root/scripts/hippocamp-dream.cjs" \
    --project "$project" \
    --write \
    --json \
    --threshold-chars "$HIPPOCAMP_DREAM_THRESHOLD_CHARS" \
    --target-chars "$HIPPOCAMP_DREAM_TARGET_CHARS" \
    > "$result_file"; then
    echo "Dream failed for ${project}; continuing with remaining projects." >&2
    failed+=("$project")
    git checkout -- .
    continue
  fi

  if git diff --quiet -- "projects/${project}/current_state.md" "projects/${project}/open_threads.md"; then
    echo "No Dream diff for ${project}"
    continue
  fi

  git add "projects/${project}/current_state.md" "projects/${project}/open_threads.md"
  git commit -m "Dream compact ${project} memory"

  if git ls-remote --exit-code --heads origin "refs/heads/${branch}" >/dev/null 2>&1; then
    git fetch origin "refs/heads/${branch}:refs/remotes/origin/${branch}"
  fi

  git push --force-with-lease origin "HEAD:refs/heads/${branch}"

  node - "$project" "$result_file" > "$body_file" <<'NODE'
const fs = require("node:fs");
const project = process.argv[2];
const payload = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const result = payload.results[0];
const lines = [
  `Dream compacted \`${project}\` curated memory.`,
  "",
  "Before:",
  `- wake_up: ${result.wakeUpChars} chars`,
  `- current_state.md: ${result.files["current_state.md"]} bytes`,
  `- open_threads.md: ${result.files["open_threads.md"]} bytes`,
  "",
  "Context:",
  `- open threads found: ${result.context.openThreads}`,
  `- threads with event evidence: ${result.context.threadsWithEvidence}`,
  `- event evidence snippets: ${result.context.evidenceItems}`,
  `- evidence budget used: ${result.context.evidenceChars}/${result.context.evidenceBudgetChars} chars`,
  "",
  "After:",
  `- wake_up: ${result.afterWakeUpChars} chars`,
  `- current_state.md + open_threads.md: ${result.afterBytes} bytes`,
  "",
  "Policy:",
  "- touched only `current_state.md` and `open_threads.md`",
  "- used bounded cue-indexed event evidence for thread decisions",
  "- did not modify append-only events or cue indexes",
  "- moved historical detail out of wake-up context",
];
console.log(lines.join("\n"));
NODE

  existing="$(gh pr list --repo "$LAGOON_REPOSITORY" --head "$branch" --state open --json number --jq '.[0].number // empty')"
  title="Dream compact ${project} memory"

  if [[ -n "$existing" ]]; then
    gh pr edit "$existing" --repo "$LAGOON_REPOSITORY" --title "$title" --body-file "$body_file"
  else
    gh pr create --repo "$LAGOON_REPOSITORY" --title "$title" --body-file "$body_file" --head "$branch" --base main
  fi
done < "$work_root/projects.txt"

if ((${#failed[@]})); then
  echo "Dream failed for: ${failed[*]}" >&2
  exit 1
fi
