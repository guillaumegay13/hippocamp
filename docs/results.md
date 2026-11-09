# Results

[← Back to README](../README.md)

Every number below comes from a script in this repo, so you can rerun it. We report where Hippocamp falls short too.

## Finding the right memory

LongMemEval-S, all 470 answerable questions, top 5 results, no model involved (`npm run eval:retrieval`).

| Measure | Hippocamp | BM25 reference |
| --- | ---: | ---: |
| Right session in top 5 (Recall@5) | 90.5% | 91.4% |
| At least one right session in top 5 (Hit@5) | 96.0% | 96.8% |
| Returned text contains the answer turn | 87.9% | n/a |
| Text returned per query | 5.9k chars | 65.5k chars |
| Search latency, cold index | 42 ms | n/a |

BM25 returns whole sessions; Hippocamp returns the matching paragraphs of each result.

## Answering with it

100 LongMemEval-S questions, reader Claude Sonnet 5, grader gpt-4o with the official LongMemEval grading prompts (`npm run eval:qa`).

| What the reader gets | Text per question | Answer accuracy |
| --- | ---: | ---: |
| Hippocamp, top 5 | 6.7k chars | 71% |
| Hippocamp, top 10 | 12.9k chars | 77% |
| The correct sessions, given directly | 28.8k chars | 90% |

The same reader reaches 90% with the correct sessions, so the remaining gap is retrieval, not the reader.

## Real coding questions

53 questions about real work in a personal Lagoon across 13 projects (`npm run eval:lagoon`). This is our own test set, kept in the private Lagoon.

| Measure | Result |
| --- | ---: |
| Right event in top 5, 43 answerable questions | 42 / 43 |
| No results for 10 questions no memory is about | 10 / 10 |

## Work continuity

Does memory carry real engineering work from one coding session to the next? `npm run eval:continuity` runs real headless Claude Code (`claude-opus-5-5`, Claude Code 2.1.318 to 2.1.319) through 21 sessions over two small synthetic projects (a TypeScript webhook relay and a Python ingest job). Early sessions plant facts the way work does: a rejected library, a pinned Node version, a blocked vendor, a parked branch, a user preference. Later sessions give tickets that only go well if the agent remembers them. The prompts never say "remember" or point at memory.

In short: the same Hippocamp server, plugged unchanged into Claude Code or Codex, keeps up with each one's own memory (100% vs 96% in Claude Code, 86% vs 86% in Codex), with fewer than 5 points of difference and one run per arm. In Codex, whose built-in memory stored almost nothing, Hippocamp's memory covered 57% of the planted facts against 4%.

Each arm is installed the way a developer has it, in its own sandbox home: Claude Code defaults with native auto-memory, or Hippocamp through its real installer (`install-claude`) with auto-memory off. A blind judge (Opus, arm names and memory paths scrubbed) grades 28 checks against the diff and the tool calls. A check is n/a when the session wrote no code it applies to.

Run `full-1`, one run per arm:

| | Claude Code native memory | Hippocamp in Claude Code |
| --- | ---: | ---: |
| Checks passed | 96% (25 / 26) | 100% (20 / 20) |
| Checks marked as needing memory | 92% (11 / 12) | 100% (10 / 10) |
| Tokens per session, median | 179k | 224k |
| Time per session, median | 62 s | 73 s |
| Agent cost per run, API price | $8.84 | $9.19 |
| Memory entries at the end | 8 | 27 |
| Planted facts covered by memory | 22% | 57% |
| Memory entries that are useful (precision) | 88% | 81% |

What it shows: Hippocamp, plugged into Claude Code as a plain MCP server, does as well as Claude Code's own memory, at about the same cost (+4% dollars, +25% tokens per session). Native memory's one miss was a parked `fix/late-dedupe` branch it no longer knew about, so it rewrote the fix from scratch. Hippocamp's 8 n/a checks come mostly from one session where it correctly held a blocked vendor back and wrote no code; native also held the vendor back, but with gated code the checks could grade. A check is only counted when the session did work it applies to, so the two arms are scored on different numbers of checks (20 vs 26); this favors an arm that holds work back.

What it does not show: that Hippocamp is better. The difference is one check, from one run per arm (bootstrap 95% interval over probes: +4 points, 0 to +16). There is no no-memory run, so the "needing memory" label comes from the dataset, not from a measured baseline. An earlier development run (27 / 27 vs 24 / 27) is not used: its cases were added after a tie and its harness was unfair to native memory.

The diffs, judge prompts, grades with evidence and memory snapshots of this run are in [results/continuity-full-1](results/continuity-full-1/) (start with `report.md` and `validation.csv`). Full transcripts are left out for size.

### Same benchmark in Codex

Run `codex-1` repeats the 21 sessions in Codex (`codex exec`, codex-cli 0.159.2, `gpt-6.1-sol`, ChatGPT sign-in), same checks and same blind Opus judge. Codex native memory is its `memories` feature, turned on (it is off by default) with `min_rollout_idle_hours = 0`, because the benchmark runs sessions back to back instead of days apart. Hippocamp is installed with `install-codex`; nothing else changes.

| | Codex native memory | Hippocamp in Codex |
| --- | ---: | ---: |
| Checks passed | 86% (24 / 28) | 86% (24 / 28) |
| Checks marked as needing memory | 67% (8 / 12) | 75% (9 / 12) |
| Tokens per session, median | 166k | 238k |
| Time per session, median | 63 s | 82 s |
| Memory calls per session | 1.0 | 4.9 |
| Memory entries at the end | 4 | 31 |
| Planted facts covered by memory | 4% | 57% |
| Memory entries that are useful (precision) | 25% | 61% |

What it shows: the same Hippocamp server, with no Codex-specific code, works in Codex as it does in Claude Code. Codex called `wake_up`, `search_memory` and `append_event` on its own, and the memory it built covers as many planted facts as in Claude Code (57% in both). The two Codex arms tie on checks (bootstrap: 0 points, -14 to +14).

Codex's own memory stored almost nothing in this run: its background summaries never produced a memory from a past session, and the one real entry is a changelog preference the agent wrote as a note. The other three entries are Codex's empty templates, which the judge counts as noise. The harness turns Codex memory on but does not wait for or confirm its background step between sessions, so this arm measures Codex memory as it behaved here, not a verified working pipeline. Hippocamp's Codex memory also holds more duplicates (5) and stale entries (4) than in Claude Code, so its precision is lower (61%). Codex still passed most checks without it, from the repository itself (code, commit messages, notes it wrote in the repo); that is why the score does not drop more. Hippocamp's misses include one stale next step and one fact it never saved (a blocked vendor).

Codex reports no dollar cost, so this run has token and time numbers only.

### How memory quality is scored

At the end of each run, a judge labels every memory entry, across both projects, as a current fact, a stale fact, other useful context, noise or a duplicate. Coverage is the share of planted facts with at least one current entry. Each entry is credited with one fact at most, so a native memory file that lists several facts in one entry gets credit for one of them: coverage favors memories that store one fact per entry, like Hippocamp's events, and the native coverage figures are a lower bound. A first version of this report judged only one project of Hippocamp's memory and gave it 30% (Claude Code) and 35% (Codex); this was fixed and re-judged without re-running any session.

The run data is in [results/continuity-codex-1](results/continuity-codex-1/).

## Why less text matters

Memory results share the agent's context with code, diffs, and tool output, and agents search several times per task. About 6k characters per search is roughly 1.5k tokens; whole sessions would be about 16k. Fewer tokens make each turn cheaper and faster, and keep the relevant lines from being buried. Less text is only useful when the answer is still in it, which is why we report answer accuracy next to text size.

## Limits

- Recall@5 is just under the BM25 reference, by less than 1 point, with 11 times less text.
- No embeddings or semantic search: a memory written in other words can be missed. On LongMemEval-S, 9 of 470 questions miss with no word in common with the answer.
- Answer accuracy is measured on 100 questions, about plus or minus 4 points.
- Self-reported scores from other memory systems use their own readers and graders, so they are not directly comparable with these.

## Reproduce

`npm run eval:retrieval` measures search on LongMemEval-S without any model: Recall@5, Hit@5, MRR, snippet evidence (the returned text comes from an answer turn), returned context size, and latency, next to an in-process BM25 reference. Run it with `--help` for the one-time data download.

`npm run eval:lagoon` runs the same kind of check, read-only, against your real Lagoon. It reads cases from `<Lagoon root>/evals/retrieval-cases.json`: a project, a query, and the event ids that answer it. An empty list means no memory should be returned. Keep the cases in Lagoon, not in this repo, because they quote private work.

`npm run eval:continuity -- --systems cc-native,cc-hippocamp --run <name>` (or `codex-native,codex-hippocamp`, which needs a Codex ChatGPT sign-in) reruns the work continuity benchmark with your Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN` in `.env`); `--report <name>` prints the tables, and `--dry-run` shows the cost estimate. A run stops cleanly at a usage limit and resumes where it stopped.

`npm run eval:qa` measures answer accuracy on the same LongMemEval-S data with the official LongMemEval reader and grader prompts. It compares Hippocamp top 5 (`hippocamp`), top 10 (`hippocamp-k10`), and the labeled answer sessions (`oracle`). It calls an OpenAI-compatible endpoint from `MANIFEST_BASE_URL` and `MANIFEST_API_KEY`; set `QA_READER_MODEL` and `QA_GRADER_MODEL` to change models. Results are cached in `.context/qa-results.jsonl`, and `--dry-run` shows the jobs and token estimates without any API call.
