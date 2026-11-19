# Email action classifier — candidate scorecard

_Generated 2026-11-19 20:42 UTC by `evals/run.sh` on the fixed held-out split (cutoff 2026-09-15). Aggregate metrics only._

**Test rows:** 373 (18 respond, 355 archive; mark-read is train-only by design).

| candidate | respond P | respond R | respond F1 | archive F1 | accuracy |
| --- | --: | --: | --: | --: | --: |
| v1 (`v1-20261119-0827`) | 0.242 | 0.444 | 0.314 | 0.934 | 0.874 |
| v1.5 (`v1.5-20261119-0920`) | 0.400 | 0.778 | 0.528 | 0.931 | 0.869 |
| v3 (`v3-20261119-2005`) | 0.323 | 0.556 | 0.408 | 0.952 | 0.895 |
| v3.5 (`v3.5-20261119-2007`) | 0.356 | 0.889 | 0.508 | 0.950 | 0.906 |
| deployed (`v1.5-20261119-0920`) | 0.400 | 0.778 | 0.528 | 0.931 | 0.869 |
| neural (`neural-qwen25-05b-lora`) | 0.385 | 0.833 | 0.526 | 0.961 | 0.928 |

respond F1 is the primary target; archive F1 is the guardrail. A candidate deploys only if it beats the classical baseline on the same split (eval numbers decide).

## Confusion — v1

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 8       | 8       | 2         |
| **archive**   | 25      | 318     | 12        |
| **mark-read** | —       | —       | —         |

## Confusion — v1.5

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 14      | 1       | 3         |
| **archive**   | 21      | 310     | 24        |
| **mark-read** | —       | —       | —         |

## Confusion — v3

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 10      | 2       | 6         |
| **archive**   | 21      | 324     | 10        |
| **mark-read** | —       | —       | —         |

## Confusion — v3.5

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 16      | 1       | 1         |
| **archive**   | 29      | 322     | 4         |
| **mark-read** | —       | —       | —         |

## Confusion — deployed

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 14      | 1       | 3         |
| **archive**   | 21      | 310     | 24        |
| **mark-read** | —       | —       | —         |

## Confusion — neural

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 15      | 3       | 0         |
| **archive**   | 24      | 331     | 0         |
| **mark-read** | —       | —       | —         |
