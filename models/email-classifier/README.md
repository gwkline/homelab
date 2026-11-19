# Email action classifier (v3)

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

### v3 full-history expansion

Gavin's call: the 2.9k rows were still a sliver of a 107k-message mailbox — "use literally all of this data." v3 drains the whole mailbox (`fetch/mine_history.py`, see `fetch/README.md`) and re-derives labels over every thread:

- `src/label_history.py` — same behavioral rules as `label.py`, applied to every thread instead of sampled exports; the full sweep also sees TRASH/SPAM/DRAFT rows the q-filtered v1/v2 exports never did, so those skips moved into the labeling rules. The output carries an `era` (UTC year) per row, and the run prints a v2-agreement audit over every shared id.
- `src/build_train_v3.py` — builds the v3 train set. **The promotion gate stays the frozen v2 held-out split** (`data/gate_ids.json`, 373 ids): v3 training excludes gate ids, and post-cutoff rows outside the gate join neither train nor test — they become the live-drift reconciliation batch for homelab issue #526. Training switches to the expanded set via `EMAIL_CLASSIFIER_TRAIN`; the gate files never follow that override.
- `src/era_eval.py` — era-stratified diagnostics, reported separately on purpose: label drift across years (respond share by era) and a per-era carve-out scorecard. Behavioral drift is expected and reported, never hidden behind the gate.
- `src/scorecard.py` — contests candidates on the frozen gate: `v1`, `v1.5` (frozen incumbent snapshot), `v3` candidate, `deployed` (symlink target), and the neural eval.

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

### v3 outcome (2026-11-19)

The full-history sweep (see `fetch/README.md`) produced a 29,062-row corpus — 9.9x v2 — with complete reply-thread coverage (all 1,362 sent-bearing threads; the 2,215 sent messages match the v2 audit exactly), an era-balanced 28% sample of the rest, and a 100% label-agreement audit against every shared v2 id (2,549/2,549) plus the frozen gate (353 rows re-derived, zero disagreements). Era diagnostics (`evals/era-report.md`) show ~20x behavioral drift: respond share falls from ~59% (2018-2020, college-era personal mail) to ~2.6% (2024-2026, notification-dominated) — which is exactly why era-balanced training _dilutes_ the recent-sender priors the gate measures: plain v3 scored respond F1 0.408 vs the incumbent's 0.528. Windowing the prior pool to recent rows (v3.5) restores respond recall to 0.889 (best of any candidate) with a stronger archive guardrail (0.950) and accuracy (0.906), but respond F1 0.508 still sits under the incumbent's 0.528 — so **v1.5 stays deployed; eval numbers decide.** The neural retry on the expanded corpus closed most of its old gap (v1-era neural: respond F1 0.390; v3-era neural: 0.526 with the best guardrail 0.961 and accuracy 0.928) but still does not strictly beat the incumbent — and a neural "win" would additionally require a new serving path, which a 0.002-F1 tie nowhere near justifies. No candidate clears the bar without beating it.

The unmined tail (57,843 threads) is checkpoint-resumable in `$EMAIL_CLASSIFIER_HOME/mine/` — a follow-up pass closes it without re-fetching anything already stored.

```sh
export EMAIL_CLASSIFIER_HOME=~/git-dev/email-classifier-local

python3 fetch/mine_history.py all                       # sweep -> $HOME/mine/
.venv/bin/python src/label_history.py                   # -> data/labeled_v3.jsonl
.venv/bin/python src/build_train_v3.py                  # gate-frozen train set
.venv/bin/python src/era_eval.py                        # era diagnostics (never the gate)
EMAIL_CLASSIFIER_TRAIN=$HOME/data/labeled_v3_train.jsonl \
EMAIL_CLASSIFIER_MODEL_DIR=$HOME/artifacts/model-v3 \
EMAIL_CLASSIFIER_VERSION_PREFIX=v3 .venv/bin/python src/train.py
# neural retry: same EMAIL_CLASSIFIER_TRAIN, .venv-mlx, stages prep/train/eval
.venv/bin/python src/scorecard.py                       # contest on the frozen gate
```

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
