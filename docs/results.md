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

`npm run eval:continuity` runs real headless Claude Code (`claude-opus-5-5`) through 21 synthetic sessions over two projects, a TypeScript webhook relay and a Python CSV pipeline: 14 work tickets and 7 probe tickets with 28 hidden checks. It runs once with Claude Code's native auto-memory and once with Hippocamp. No prompt asks the agent to look anything up. An Opus judge grades each check from the diff, the tool calls and the memory available when the probe started.

| System | Checks passed | Memory-only checks | Cross-project preferences | Agent cost (API price) |
| --- | ---: | ---: | ---: | ---: |
| Claude Code native memory | 24 / 27 | 9 / 12 | 3 / 4 | $7.30 |
| Hippocamp | 27 / 27 | 12 / 12 | 4 / 4 | $8.93 |

Memory-only checks cannot be passed from the repo alone. One check had nothing to grade in either run (no new tests were written).

Native memory missed three checks, all in the Python project:

- It raised the warehouse chunk size back from 2,000 to 10,000 rows. Six sessions earlier, the chunk size had been lowered to 2,000 because the warehouse rejects requests over 4 MB. Native memory never stored that reason.
- It reported that nothing was in progress, missing that the next step was a cp1252 fallback for one vendor's file. This was never stored either.
- It did not add a CHANGELOG line. The user had asked for one in every repo, but native memory saved that preference only under the other project.

Hippocamp passed all three. It stored the same facts as events, and in the third case as a global preference. It cost about 22% more because of its memory tool calls.

The first 12 sessions ran first, and both systems passed all 11 of their checks. The rest was added later as an extension of the same run, without redoing those sessions. Two early sessions, one per system, were cut off by a usage limit and rerun; any memory written before the cutoff was kept. This is a single run per system, so treat the gap as a first signal, not a measured rate.

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

`npm run eval:qa` measures answer accuracy on the same LongMemEval-S data with the official LongMemEval reader and grader prompts. It compares Hippocamp top 5 (`hippocamp`), top 10 (`hippocamp-k10`), and the labeled answer sessions (`oracle`). It calls an OpenAI-compatible endpoint from `MANIFEST_BASE_URL` and `MANIFEST_API_KEY`; set `QA_READER_MODEL` and `QA_GRADER_MODEL` to change models. Results are cached in `.context/qa-results.jsonl`, and `--dry-run` shows the jobs and token estimates without any API call.
