# Email action classifier — standing eval

_Generated 2026-11-19 08:45 UTC by `evals/run.sh` (one command, deterministic split)._

**Held-out split:** every labeled message dated on/after **2026-09-15** (newest ~2 months). Train uses only older mail. Test coverage: 2026-09-15 → 2026-11-19.

**Model:** `v1-20261119-0827` — sentence-transformers/all-MiniLM-L6-v2 embeddings (384-d, normalized) + logistic regression (class_weight=balanced).

## Class balance

| label     |    train |    test |
| --------- | -------: | ------: |
| respond   |       39 |      18 |
| archive   |     1134 |     175 |
| mark-read |       15 |       0 |
| **total** | **1188** | **193** |

`mark-read` exception: the 15 mark-read rows all post-date the cutoff, because the class is only observable on the _current_ inbox (historical read-inbox mail was eventually archived). They train the model and are excluded from this held-out test, so `mark-read` appears only as a prediction column below — its recall is unmeasurable until labeled behavior history accumulates (a filed v2 follow-up).

## Per-class metrics (held-out)

```
precision    recall  f1-score   support

     respond      0.421     0.444     0.432        18
     archive      0.951     0.891     0.920       175
   mark-read      0.000     0.000     0.000         0

    accuracy                          0.850       193
   macro avg      0.457     0.445     0.451       193
weighted avg      0.902     0.850     0.875       193
```

Accuracy: **0.850** — majority-class baseline (`archive` always): **0.907**. Accuracy sits below the baseline _on purpose_: `class_weight=balanced` trades archive accuracy for respond recall, and catching reply-worthy mail is the point — grade the per-class table, not the headline accuracy.

## Confusion matrix (rows = true, cols = predicted)

| true \ pred   | respond | archive   | mark-read |
| ------------- | ------- | --------- | --------- |
| **respond**   | 8 (44%) | 8 (44%)   | 2 (11%)   |
| **archive**   | 11 (6%) | 156 (89%) | 8 (5%)    |
| **mark-read** | —       | —         | —         |

## Notes for iterating

- Exported data: a stride-10 sample of the last ~30k archived messages, all sent-reply threads, and the read-inbox population; see `fetch/README.md`.
- Regenerate after re-export + retrain with `evals/run.sh`; the split date is pinned in `src/common.py` so numbers stay comparable.
- v2 ideas live in the homelab issue tracker (label `email-classifier`).
