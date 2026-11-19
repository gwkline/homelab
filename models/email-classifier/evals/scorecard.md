# Email action classifier — candidate scorecard

_Generated 2026-11-19 16:01 UTC by `evals/run.sh` on the fixed held-out split (cutoff 2026-09-15). Aggregate metrics only._

**Test rows:** 373 (18 respond, 355 archive; mark-read is train-only by design).

| candidate | respond P | respond R | respond F1 | archive F1 | accuracy |
| --- | --: | --: | --: | --: | --: |
| v1 (`v1-20261119-0827`) | 0.242 | 0.444 | 0.314 | 0.934 | 0.874 |
| v1.5 (`v1.5-20261119-0920`) | 0.400 | 0.778 | 0.528 | 0.931 | 0.869 |
| deployed (`v1.5-20261119-0920`) | 0.400 | 0.778 | 0.528 | 0.931 | 0.869 |
| neural (`neural-qwen25-05b-lora`) | 0.348 | 0.444 | 0.390 | 0.965 | 0.933 |

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

## Confusion — deployed

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 14      | 1       | 3         |
| **archive**   | 21      | 310     | 24        |
| **mark-read** | —       | —       | —         |

## Confusion — neural

| true \\ pred  | respond | archive | mark-read |
| ------------- | ------- | ------- | --------- |
| **respond**   | 8       | 10      | 0         |
| **archive**   | 15      | 340     | 0         |
| **mark-read** | —       | —       | —         |
