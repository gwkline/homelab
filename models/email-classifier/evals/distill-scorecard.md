# Email action classifier — v5 distillation scorecard (#543)

_Generated 2026-11-20 06:24 UTC on the FROZEN 373-row gate (data/gate_ids.json, v2 labels), identical instrument to evals/scorecard.md. Bundles with a tuned respond threshold are scored by the serving rule (threshold column); the incumbent keeps argmax. Aggregate metrics only._

Instrument verification: incumbent v1.5 re-run reproduces published bars and the batch-scored teacher reproduces its published gate row (PASS).

| candidate | version | rule | respond P | respond R | respond F1 | archive F1 | accuracy |
| --- | --- | --- | --: | --: | --: | --: | --: |
| v1.5 (incumbent) | `v1.5-20261119-0920` | argmax | 0.400 | 0.778 | 0.528 | 0.931 | 0.869 |
| v3-full (new-data baseline) | `v3-full-20261120-0247` | argmax | 0.400 | 0.444 | 0.421 | 0.967 | 0.933 |
| v5d-soft (distill) | `v5d-soft-20261120-0623` | threshold | 0.359 | 0.778 | 0.491 | 0.958 | 0.922 |
| v5d-hard (distill) | `v5d-hard-20261120-0622` | threshold | 0.333 | 0.556 | 0.417 | 0.960 | 0.925 |
| teacher (reference) | `neural-v4-qwen25-15b-lora-20261119` | threshold | 0.429 | 0.833 | 0.566 | 0.967 | 0.938 |

respond F1 is the primary target; archive F1 is the guardrail (incumbent 0.931). A distilled student ships as the classical FALLBACK only on a strict win: respond F1 > 0.528 with archive F1 >= 0.931; the neural stays the primary serving path either way.

## Confusion — v1.5 (incumbent)

| true \ pred   | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 14      | 1       | 3         |
| **archive**   | 21      | 310     | 24        |
| **mark-read** | —       | —       | —         |

## Confusion — v3-full (new-data baseline)

| true \ pred   | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 8       | 8       | 2         |
| **archive**   | 12      | 340     | 3         |
| **mark-read** | —       | —       | —         |

## Confusion — v5d-soft (distill)

| true \ pred   | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 14      | 4       | 0         |
| **archive**   | 25      | 330     | 0         |
| **mark-read** | —       | —       | —         |

## Confusion — v5d-hard (distill)

| true \ pred   | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 10      | 8       | 0         |
| **archive**   | 20      | 335     | 0         |
| **mark-read** | —       | —       | —         |

## Gate calibration (reliability bins, aggregate counts only)

**v1.5 (incumbent)** — ECE 0.0499

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 296 |    0.0050 |   0.0000 |
| 0.1-0.2        |  15 |    0.1607 |   0.0000 |
| 0.2-0.3        |  12 |    0.2554 |   0.0000 |
| 0.3-0.4        |  14 |    0.3508 |   0.2143 |
| 0.4-0.5        |  14 |    0.4482 |   0.5714 |
| 0.5-0.6        |   5 |    0.5325 |   0.4000 |
| 0.6-0.7        |   7 |    0.6607 |   0.2857 |
| 0.7-0.8        |   7 |    0.7470 |   0.2857 |
| 0.8-0.9        |   3 |    0.8299 |   0.3333 |

**v3-full (new-data baseline)** — ECE 0.0409

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 324 |    0.0082 |   0.0031 |
| 0.1-0.2        |  14 |    0.1470 |   0.1429 |
| 0.2-0.3        |   9 |    0.2439 |   0.5556 |
| 0.3-0.4        |   3 |    0.3580 |   0.6667 |
| 0.4-0.5        |   4 |    0.4445 |   0.0000 |
| 0.5-0.6        |   3 |    0.5404 |   0.3333 |
| 0.7-0.8        |   3 |    0.7393 |   0.3333 |
| 0.8-0.9        |   3 |    0.8443 |   0.3333 |
| 0.9-1.0        |  10 |    0.9661 |   0.5000 |

**v5d-soft (distill)** — ECE 0.0353

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 295 |    0.0115 |   0.0000 |
| 0.1-0.2        |  27 |    0.1421 |   0.0741 |
| 0.2-0.3        |  12 |    0.2419 |   0.1667 |
| 0.3-0.4        |  15 |    0.3418 |   0.4000 |
| 0.4-0.5        |   4 |    0.4557 |   0.5000 |
| 0.5-0.6        |  12 |    0.5501 |   0.3333 |
| 0.6-0.7        |   5 |    0.6408 |   0.4000 |
| 0.7-0.8        |   3 |    0.7315 |   0.0000 |

**v5d-hard (distill)** — ECE 0.1148

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 279 |    0.0120 |   0.0000 |
| 0.1-0.2        |  17 |    0.1303 |   0.0000 |
| 0.2-0.3        |  10 |    0.2305 |   0.0000 |
| 0.3-0.4        |   5 |    0.3613 |   0.2000 |
| 0.4-0.5        |   4 |    0.4437 |   0.0000 |
| 0.5-0.6        |   5 |    0.5458 |   0.2000 |
| 0.6-0.7        |  12 |    0.6400 |   0.0833 |
| 0.7-0.8        |   3 |    0.7487 |   0.3333 |
| 0.8-0.9        |   5 |    0.8532 |   0.4000 |
| 0.9-1.0        |  33 |    0.9831 |   0.3636 |

**teacher (reference)** — ECE 0.0372

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 298 |    0.0050 |   0.0000 |
| 0.1-0.2        |  13 |    0.1597 |   0.0000 |
| 0.2-0.3        |  19 |    0.2402 |   0.1053 |
| 0.3-0.4        |   7 |    0.3605 |   0.1429 |
| 0.4-0.5        |  12 |    0.4656 |   0.1667 |
| 0.5-0.6        |  15 |    0.5548 |   0.6000 |
| 0.6-0.7        |   7 |    0.6385 |   0.5714 |
| 0.7-0.8        |   2 |    0.7571 |   0.0000 |
