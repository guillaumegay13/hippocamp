# Work continuity: codex-1

## Outcome

| Arm | Runs | Pass | Memory-required | n/a | Agent $ |
|---|---|---|---|---|---|
| codex-native | 1 | 86% (24/28) | 67% (8/12) | 0 | $0.00 |
| codex-hippocamp | 1 | 86% (24/28) | 75% (9/12) | 0 | $0.00 |

Agent $ is per run, at API price. Note: no cc-none run: memory-required falls back to the dataset's memory flag.

## By kind and distance

| Arm | state | decision | constraint | asset | done | preference | 1-2 | 3-5 | 6+ |
|---|---|---|---|---|---|---|---|---|---|
| codex-native | 33% (1/3) | 100% (6/6) | 80% (4/5) | 100% (3/3) | 100% (2/2) | 89% (8/9) | 0% (0/2) | 75% (6/8) | 100% (18/18) |
| codex-hippocamp | 67% (2/3) | 83% (5/6) | 80% (4/5) | 67% (2/3) | 100% (2/2) | 100% (9/9) | 100% (2/2) | 63% (5/8) | 94% (17/18) |

## Efficiency

| Arm | Tokens/session (median) | Time/session (median) | Memory calls/session | Memory bytes/session | $ per run | Memory tokens per memory-required pass |
|---|---|---|---|---|---|---|
| codex-native | 165574 | 62.6s | 1.0 | 1087 | $0.00 | 713 |
| codex-hippocamp | 238238 | 81.8s | 4.9 | 8499 | $0.00 | 4958 |

## Memory quality

| Arm | Entries | Coverage | Precision | Stale | Noise | Duplicates |
|---|---|---|---|---|---|---|
| codex-hippocamp | 31 | 57% | 61% | 4.0 | 3.0 | 5.0 |
| codex-native | 4 | 4% | 25% | 0.0 | 3.0 | 0.0 |

## Differences (bootstrap over probes)

- codex-hippocamp vs codex-native: +0 points (95% CI -14 to 14)
