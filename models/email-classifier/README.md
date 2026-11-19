# Email action classifier (v1)

Predicts the action Gavin takes on an incoming email: `respond`, `archive`, or `mark-read`. Small by design: local sentence-transformer embeddings + logistic regression. No GPU, no fine-tuning, no paid APIs.

## Layout

- `fetch/` — Gmail export procedure (Executor MCP sidecar) and its script.
- `src/` — labeling, training, evaluation.
- `api/` — FastAPI inference service.
- `evals/` — standing eval suite; `evals/run.sh` regenerates `evals/report.md` from the held-out time split.
- `data/` — Gmail-derived training data. **Never committed.** Populated by the export below; `.gitignore` excludes it.
- `artifacts/` — trained model + embedding model. **Never committed** (the classifier weights are derived from the private mailbox).

## Environment

Everything resolves from `EMAIL_CLASSIFIER_HOME` (default: this directory):

```
$EMAIL_CLASSIFIER_HOME/
  data/raw/*.jsonl        # raw Gmail metadata exports
  data/labeled.jsonl      # behavior labels
  artifacts/model/        # model.joblib, metadata.json, embedding-model/
  artifacts/embedding-model/  # sentence-transformers snapshot used at train
  eval/report.md          # copy of the eval report
```

Local dev on the laptop keeps `EMAIL_CLASSIFIER_HOME` outside the repo (for example `~/git-dev/email-classifier-local`) so the private artifacts never sit in a public checkout.

## Labels (from behavior, not manual annotation)

| label | derived from |
| --- | --- |
| `respond` | an incoming message that precedes one of Gavin's sent replies in the same thread |
| `archive` | a message archived (by Gavin or his filters) with no reply from him in that thread |
| `mark-read` | a message read but still in the inbox with no reply |

`read-later` was considered and dropped: the mailbox shows no behavior that separates it from `mark-read` (no read-later label exists and read-inbox messages number ~15), so v1 keeps three classes.

## Pipeline

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

export EMAIL_CLASSIFIER_HOME=~/git-dev/email-classifier-local

# 1. export raw data (see fetch/README.md) -> data/raw/
# 2. label
.venv/bin/python src/label.py
# 3. train (embeddings + logistic regression)
.venv/bin/python src/train.py
# 4. eval -> evals/report.md (held-out split: everything after TEST_CUTOFF)
.venv/bin/python src/eval_model.py
```

`evals/run.sh` is the one-command standing eval: it re-runs `src/eval_model.py` and regenerates `evals/report.md`. The held-out split is fixed by `TEST_CUTOFF` in `src/common.py` (time split, newest ~2 months), so eval numbers are comparable across runs while the data catches up.

## Inference API

The served copy lives with the deployment at `deploy/email-classifier/base/api/main.py` (kustomize only loads ConfigMap sources from inside its own base). It is self-contained; its `compose_text` mirrors `src/common.py` here — keep the two identical.

```sh
.venv/bin/uvicorn main:app --app-dir ../deploy/email-classifier/base/api --port 8080
curl -s localhost:8080/predict -H 'content-type: application/json' \
  -d '{"from": "ACME <no-reply@acme.com>", "subject": "Your order shipped", "snippet": "Your order is on the way"}'
```

Deployed to the homelab cluster from `deploy/email-classifier/` — see that directory's README for the populate-and-rollout steps (the model artifact travels out-of-band, never through this public repo).
