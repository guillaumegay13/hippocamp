# Work continuity: full-1

## Outcome

| Arm | Runs | Pass | Memory-required | n/a | Agent $ |
|---|---|---|---|---|---|
| cc-native | 1 | 96% (25/26) | 92% (11/12) | 2 | $8.84 |
| cc-hippocamp | 1 | 100% (20/20) | 100% (10/10) | 8 | $9.19 |

Agent $ is per run, at API price. Note: no cc-none run: memory-required falls back to the dataset's memory flag.

## By kind and distance

| Arm | state | decision | constraint | asset | done | preference | 1-2 | 3-5 | 6+ |
|---|---|---|---|---|---|---|---|---|---|
| cc-native | 67% (2/3) | 100% (4/4) | 100% (5/5) | 100% (3/3) | 100% (2/2) | 100% (9/9) | 50% (1/2) | 100% (8/8) | 100% (16/16) |
| cc-hippocamp | 100% (3/3) | 100% (4/4) | 100% (4/4) | 100% (2/2) | 100% (1/1) | 100% (6/6) | 100% (1/1) | 100% (8/8) | 100% (11/11) |

## Efficiency

| Arm | Tokens/session (median) | Time/session (median) | Memory calls/session | Memory bytes/session | $ per run | Memory tokens per memory-required pass |
|---|---|---|---|---|---|---|
| cc-native | 179198 | 61.6s | 1.0 | 2696 | $8.84 | 1287 |
| cc-hippocamp | 223624 | 72.9s | 2.9 | 6922 | $9.19 | 3634 |

## Memory quality

| Arm | Entries | Coverage | Precision | Stale | Noise | Duplicates |
|---|---|---|---|---|---|---|
| cc-hippocamp | 27 | 57% | 81% | 2.0 | 3.0 | 0.0 |
| cc-native | 8 | 22% | 88% | 0.0 | 0.0 | 1.0 |

## Differences (bootstrap over probes)

- cc-hippocamp vs cc-native: +4 points (95% CI 0 to 16)
