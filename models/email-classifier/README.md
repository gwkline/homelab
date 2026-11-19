# Email action classifier (v2)

Predicts the action Gavin takes on an incoming email: `respond`, `archive`, or `mark-read`. Small by design: local sentence-transformer embeddings + engineered behavioral features + logistic regression, with a LoRA fine-tuned Qwen-0.5B neural candidate evaluated against it on the same split (eval numbers decide which one serves). No paid APIs.

## Layout

- `fetch/` — Gmail export procedure (Executor MCP sidecar) and its script.
- `src/` — labeling, training, evaluation, scorecard, neural candidate.
- `api/` — FastAPI inference service.
- `evals/` — standing eval suite; `evals/run.sh` regenerates `evals/report.md` + `evals/scorecard.md` from the held-out time split.
- `data/` — Gmail-derived training data. **Never committed.** Populated by the export below; `.gitignore` excludes it.
- `artifacts/` — trained model + embedding model. **Never committed** (the classifier weights are derived from the private mailbox).

## Environment

Everything resolves from `EMAIL_CLASSIFIER_HOME` (default: this directory):

```
$EMAIL_CLASSIFIER_HOME/
  data/raw/*.jsonl        # raw Gmail metadata exports
  data/labeled.jsonl      # behavior labels
  artifacts/model/        # model.joblib, metadata.json, embedding-model/
  artifacts/model-v1-snapshot/  # frozen v1 bundle for the scorecard
  artifacts/neural-data/  # chat-format train/valid for the LoRA run
  artifacts/neural-adapter/, artifacts/neural-fused/
  artifacts/neural-eval.json    # neural predictions on the held-out split
  eval/report.md, eval/scorecard.md
```

Local dev on the laptop keeps `EMAIL_CLASSIFIER_HOME` outside the repo (for example `~/git-dev/email-classifier-local`) so the private artifacts never sit in a public checkout.

## Labels (from behavior, not manual annotation)

| label | derived from |
| --- | --- |
| `respond` | an incoming message that immediately precedes one of Gavin's sent replies in the same thread |
| `archive` | a message archived (by Gavin or his filters) with no reply from him in that thread |
| `mark-read` | a message read but still in the inbox with no reply |

`read-later` was considered and dropped: the mailbox shows no behavior that separates it from `mark-read`, so v2 keeps three classes.

### v2 data expansion

The v1 dataset (1,381 rows, 57 respond) was the constraint, not the model class. v2 expands it to ~2.9k rows:

- **Reply-thread audit.** v1 scanned only ~139 of ~2.2k sent messages. A full `in:sent subject:Re:` sweep found 384 reply threads the v1 window missed (2014→2026, including recent ones) — the `respond` population grew 12x.
- **Archive gap closure.** The v1 stride-10 archive sample had 1,800 unfetched ids (not the ~250 believed at v1 hand-off — `remaining.json` only tracked a slice). The newest 600 are fetched (all of the test window); the older tail is queued in `data/raw/remaining.json` for a later pass.
- **Thread-context negatives.** Non-trigger incoming messages inside replied threads label as `archive`/`mark-read` — hard negatives sitting right beside `respond` examples, which the stride sample never captured.
- New exports carry `List-Unsubscribe`/`Precedence` flags for the bulk-sender feature.

## Pipeline

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

export EMAIL_CLASSIFIER_HOME=~/git-dev/email-classifier-local

# 1. export raw data (see fetch/README.md) -> data/raw/
# 2. label (respond triggers from all reply-thread exports + thread context)
.venv/bin/python src/label.py
# 3. train v1.5 (embeddings + sender-prior/bulk/reply features + logreg)
.venv/bin/python src/train.py
# 4. eval + scorecard -> evals/report.md, evals/scorecard.md
.venv/bin/python src/eval_model.py
.venv/bin/python src/scorecard.py
```

`evals/run.sh` is the one-command standing eval: it re-runs the eval and regenerates both markdown files. The held-out split is fixed by `TEST_CUTOFF` in `src/common.py` (time split, newest ~2 months), so eval numbers are comparable across runs while the data catches up.

### v1.5 features

`src/common.py` appends four leak-free signals to the 384-d embedding (priors computed from train rows only, frozen into the bundle so serving matches eval exactly):

- smoothed per-sender respond prior (the strongest single feature — senders Gavin has replied to before);
- log-scaled sender volume;
- bulk/newsletter flag (List-Unsubscribe header where exported, sender/snippet patterns everywhere);
- `Re:`/`Fwd:` subject flag.

## Neural candidate (eval-gated)

`src/train_neural.py` fine-tunes Qwen2.5-0.5B-Instruct with LoRA (MLX, Apple Silicon; run from `EMAIL_CLASSIFIER_HOME`'s own `.venv-mlx` — `uv venv .venv-mlx --python 3.12 && uv pip install --python .venv-mlx/bin/python mlx-lm`) as a 3-way classifier over the same prompt information, on the same split. Stages: `prep`, `train`, `eval`. The eval writes `artifacts/neural-eval.json`, which the scorecard picks up automatically.

Per the standing rule, the neural candidate deploys only if it beats the classical baseline on the same split; otherwise the numbers are reported and it stays on the laptop.

## Inference API

The served copy lives with the deployment at `deploy/email-classifier/base/api/main.py` (kustomize only loads ConfigMap sources from inside its own base). It is self-contained; its `compose_text` and feature helpers mirror `src/common.py` here — keep the two identical. It serves both bundle generations (feature-aware since v1.5), so a model-dir rollback needs no code change.

```sh
.venv/bin/uvicorn main:app --app-dir ../deploy/email-classifier/base/api --port 8080
curl -s localhost:8080/predict -H 'content-type: application/json' \
  -d '{"from": "ACME <no-reply@acme.com>", "subject": "Your order shipped", "snippet": "Your order is on the way"}'
```

Deployed to the homelab cluster from `deploy/email-classifier/` — see that directory's README for the populate-and-rollout steps (the model artifact travels out-of-band, never through this public repo).
