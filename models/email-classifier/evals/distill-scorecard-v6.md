# Email action classifier — v6 distill retry scorecard (#545) — sender-disjoint VAL + complete corpus

_Generated 2026-11-20 10:10 UTC on the FROZEN 373-row gate (data/gate_ids.json, v2 labels), identical instrument to evals/scorecard.md. Bundles with a tuned respond threshold are scored by the serving rule (threshold column); the incumbent keeps argmax. Aggregate metrics only._

Instrument verification: incumbent v1.5 re-run reproduces published bars and the batch-scored teacher reproduces its published gate row (PASS).

| candidate | version | rule | respond P | respond R | respond F1 | archive F1 | accuracy |
| --- | --- | --- | --: | --: | --: | --: | --: |
| v1.5 (incumbent) | `v1.5-20261119-0920` | argmax | 0.400 | 0.778 | 0.528 | 0.931 | 0.869 |
| v3-full (new-data baseline) | `v3-full-20261120-0815` | argmax | 0.389 | 0.389 | 0.389 | 0.965 | 0.933 |
| v6d-soft (distill) | `v6d-soft-20261120-1008` | threshold | 0.000 | 0.000 | 0.000 | 0.975 | 0.952 |
| v6d-hard (distill) | `v6d-hard-20261120-1008` | threshold | 0.333 | 0.278 | 0.303 | 0.968 | 0.938 |
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
| **respond**   | 7       | 11      | 0         |
| **archive**   | 11      | 341     | 3         |
| **mark-read** | —       | —       | —         |

## Confusion — v6d-soft (distill)

| true \ pred   | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 0       | 18      | 0         |
| **archive**   | 0       | 355     | 0         |
| **mark-read** | —       | —       | —         |

## Confusion — v6d-hard (distill)

| true \ pred   | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 5       | 13      | 0         |
| **archive**   | 10      | 345     | 0         |
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

**v3-full (new-data baseline)** — ECE 0.0422

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 327 |    0.0076 |   0.0031 |
| 0.1-0.2        |  18 |    0.1437 |   0.3333 |
| 0.2-0.3        |   4 |    0.2522 |   0.0000 |
| 0.3-0.4        |   2 |    0.3458 |   1.0000 |
| 0.4-0.5        |   6 |    0.4653 |   0.3333 |
| 0.5-0.6        |   1 |    0.5568 |   0.0000 |
| 0.8-0.9        |   3 |    0.8259 |   0.3333 |
| 0.9-1.0        |  12 |    0.9745 |   0.5000 |

**v6d-soft (distill)** — ECE 0.0803

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 259 |    0.0287 |   0.0000 |
| 0.1-0.2        |  32 |    0.1542 |   0.0000 |
| 0.2-0.3        |  20 |    0.2485 |   0.0500 |
| 0.3-0.4        |  19 |    0.3465 |   0.2105 |
| 0.4-0.5        |  14 |    0.4505 |   0.2857 |
| 0.5-0.6        |  13 |    0.5469 |   0.3846 |
| 0.6-0.7        |  12 |    0.6474 |   0.1667 |
| 0.7-0.8        |   4 |    0.7128 |   0.5000 |

**v6d-hard (distill)** — ECE 0.0622

| p(respond) bin |   n | mean pred | observed |
| -------------- | --: | --------: | -------: |
| 0.0-0.1        | 308 |    0.0124 |   0.0065 |
| 0.1-0.2        |  10 |    0.1414 |   0.0000 |
| 0.2-0.3        |  10 |    0.2517 |   0.2000 |
| 0.3-0.4        |   7 |    0.3402 |   0.2857 |
| 0.4-0.5        |   5 |    0.4407 |   0.4000 |
| 0.5-0.6        |   3 |    0.5528 |   0.3333 |
| 0.6-0.7        |   2 |    0.6604 |   0.0000 |
| 0.7-0.8        |   3 |    0.7467 |   0.3333 |
| 0.8-0.9        |   5 |    0.8564 |   0.4000 |
| 0.9-1.0        |  20 |    0.9683 |   0.3000 |

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
