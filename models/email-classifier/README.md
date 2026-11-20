# Email action classifier (v4)

Predicts the action Gavin takes on an incoming email: `respond`, `archive`, or `mark-read`. The serving stack is still local-only (no paid APIs): a classical bundle (sentence-transformer embeddings + engineered behavioral features + a GBDT head) plus — since v4 — an optional LoRA fine-tuned Qwen2.5-1.5B neural head that won the eval-gated contest and now serves, with the classical bundle as an always-available fallback. Eval numbers decide which one serves.

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

### v4 embedder + capacity contest (2026-11-19)

The v3 card banked the data lever; v4 contests representation + capacity on the same frozen gate, with one new discipline: **all selection happens on a frozen VAL carve** (`mine/val_ids_v4.json`, seeded and id-frozen by `src/train_v4.py`) — every pre-cutoff 2026 respond row (27) plus a stride-matched archive sample, era- and prevalence-matched to the gate window. Prior-window choice, Platt calibration, the respond threshold and ensemble weights tune there; the gate is scored once per frozen candidate, by the scorecard, after the fact.

- `src/train_v4.py` — classical contest: a modern embedder (BAAI/bge-base-en-v1.5 768-d and Qwen3-Embedding-0.6B 1024-d were both run) + a class-weighted GBDT head (sklearn HistGradientBoosting; respond weighted ~26x, mark-read 8x) replaces MiniLM+logreg. Embeddings cache per id (`artifacts/emb-cache/`), the sweep picks the prior window on VAL, the threshold tunes on VAL under an archive-F1 floor, and the final bundle refits on fit+VAL so the era-recent respond rows train the deployed model.
- `src/train_neural_v4.py` — the capacity candidate: Qwen2.5-1.5B-Instruct + LoRA (MLX; the 0.5B's exact tokenizer/chat template — Qwen3-1.7B was considered and passed over for its thinking-mode chat template's interplay with label-token scoring). Two hard-won corrections vs the v3 recipe: **respond oversamples 20x, not 3x** (the full-history pool is 3.7% respond; 3x collapsed the model to always-archive — visible as val loss 0.002 on an all-archive val slice), and the LoRA validation split is **stratified per class** (a date split parks the whole val slice in the 2026 archive monoculture and cannot see respond collapse at all). ITERS=480 stays under the documented NaN horizon; the val-best checkpoint is promoted (iter 480, val 0.029).
- `src/ensemble_v4.py` — stacked blend of classical + neural respond probabilities, tuned on the same VAL carve. The sweep chose w=0.00: the neural strictly dominates the blend, so the ensemble degenerates to the neural alone (reported as such, not hidden).
- `src/era_eval_v4.py` — era-stratified diagnostics with the identical carve ids as `era_eval.py` but the v4 recipe (`evals/era-report-v4.md`); the promotion decision never uses it.
- `src/reconcile_526.py` — scores a candidate over the parked 2,944-row post-cutoff #526 batch (all archive; never trained on) so the false-respond-suggestion rate on real 2026 traffic is on record for the reconciliation issue.

Contest outcome on the frozen gate (373 rows; `evals/scorecard.md`): the embedder+GBDT lane **underperformed** (bge-hist respond F1 0.346, Qwen3-embedding 0.279 vs the incumbent's 0.528) — the classical family's handicap is era-structural: the fit pool's only 2026 respond rows sit in the VAL carve, while the incumbent trained on in-era replies. The **neural won outright: respond F1 0.566** (P 0.429 / R 0.833) vs the incumbent's 0.528 (0.400/0.778), with a better archive guardrail (0.967 vs 0.931) and accuracy (0.938 vs 0.869) — a strict domination, not v3's one-row tie. Qwen2.5-1.5B serves through the existing FastAPI service (transformers + torch were already in the deployment venv; the fused model rides its own PVC; any load failure falls back to the classical bundle — see `deploy/email-classifier/README.md`).

Two honest engineering notes for whoever iterates next. xgboost 3.x rejects string eval labels when the multi objective is explicit (`Expected: [0 1 2]`) and pre-encoding would break the bundle's string-label serving contract, so the GBDT lane standardized on sklearn's HistGradientBoosting — same family, native string classes, zero new serving deps. And macOS needs `brew install libomp` before either GBDT library loads its native backends.

Reproducing the v3 corpus (unchanged by v4 — v4 consumes its outputs):

```sh
export EMAIL_CLASSIFIER_HOME=~/git-dev/email-classifier-local

python3 fetch/mine_history.py all                       # sweep -> $HOME/mine/
.venv/bin/python src/label_history.py                   # -> data/labeled_v3.jsonl
.venv/bin/python src/build_train_v3.py                  # gate-frozen train set
.venv/bin/python src/era_eval.py                        # era diagnostics (never the gate)
```

The v4 contest itself:

```sh
export EMAIL_CLASSIFIER_HOME=~/git-dev/email-classifier-local
EMAIL_CLASSIFIER_TRAIN=$HOME/data/labeled_v3_train.jsonl \
EMAIL_CLASSIFIER_EMBEDDER=$HOME/artifacts/emb-bge-base \
EMAIL_CLASSIFIER_MODEL_DIR=$HOME/artifacts/model-v4bge-hist \
EMAIL_CLASSIFIER_VERSION_PREFIX=v4bge-hist V4_HEAD=hist \
  .venv/bin/python src/train_v4.py            # classical candidate
# neural: .venv-mlx, stages prep/train/fuse/eval (sklearn installs into it)
.venv/bin/python src/ensemble_v4.py            # blend on the VAL carve
EMAIL_CLASSIFIER_HOME=$HOME .venv/bin/python src/era_eval_v4.py
.venv/bin/python src/scorecard.py             # the gate, once, for real
```

### v5 distillation contest (2026-11-19) — honest miss, no deploy

The neural-v4 teacher's judgment is strictly better than the classical fallback's (gate respond F1 0.566 vs 0.528); only its ~3 s/message latency is a liability. v5 asks whether the teacher's respond signal can be distilled into the ~25 ms classical bundle so the fallback path (and any latency-sensitive consumer) gets neural-quality suggestions at classical speed.

- `src/teacher_score.py` — batch teacher inference: scores every pool row + the frozen gate with the local fused LoRA (MLX/MPS) using the exact `train_neural_v4` label-logprob math, but 2 sequences per row (`respond`/`archive` are single tokens, so both come off the prompt-only forward; `mark-read` off prompt+`mark`) packed to a token budget — 64,888 pool + 373 gate rows in ~3 h at 6.1 rows/s on an M3 Pro. Verification: the batch pass reproduces the serial v4 eval's gate row exactly (373/373 thresholded predictions; max |dp_respond| 3.9e-3, fp16 batch-shape rounding). The teacher flags 3,809/64,888 pool rows (5.9%) as respond — the distill target distribution.
- `src/train_distill.py` — the student trainer, selection-on-VAL discipline identical to `train_v4.py`. Two variants: **soft** (temperature-transformed teacher probabilities as targets via sample-weight expansion — three weighted (x, class) terms per row is exact expected cross-entropy for the logreg head — plus a respond boost on teacher-flagged rows) and **hard** (the teacher's serving decision as labels with v4-recipe class weights). Grids: prior window {all, 2024+} x temperature {0.5, 1, 2} x boost {1..30}, logreg head with a HistGradientBoosting control; threshold tuned on VAL under the archive-F1 floor; final refit on fit+VAL with the selection-frozen threshold.
- `src/distill_scorecard.py` — the frozen-gate contest. New instrument rule, verified before any student existed: bundles carrying a tuned `respond_threshold` are scored by the SERVING rule (mirroring the deployment API), while the threshold-less incumbent keeps argmax. Two verification rows gate the table: the incumbent must reproduce 0.400/0.778/0.528 and the batch-scored teacher must reproduce 0.429/0.833/0.566 — both PASS.

Outcome on the frozen gate (`evals/distill-scorecard.md`): **the distilled students did not beat the incumbent** — v5d-soft 0.491 (P 0.359 / R 0.778, threshold 0.29), v5d-hard 0.417, vs the incumbent's 0.528 and the teacher's 0.566; archive guardrails were fine (0.958/0.960 vs 0.931). No fallback swap, no deploy — eval numbers decide. The students beat the same-data retrain baseline (v3-full 0.421), so distillation did transfer real teacher signal, but the transfer stops short of the incumbent.

The VAL selection (soft best: VAL respond F1 0.783 at T=1.0, w=1 — pure KL, no boost needed; the student even out-scored its teacher on VAL, 0.783 vs the teacher's 0.700) overstated gate quality, and the gap is structural: the student's strongest feature beyond the embedding is the frozen per-sender respond prior, and the VAL carve splits ROWS, not senders — its senders mostly appeared in the fit pool, while the gate's post-cutoff mail contains senders the priors have never seen. The teacher scores text alone, so its VAL→gate transfer is flatter. The v5d-soft bundle was additionally verified to serve correctly through the real deployment API code (8/8 probe parity, ~7 ms median), and stays on the laptop — one symlink away if a future serving-order decision wants it.

Reproduce (from `EMAIL_CLASSIFIER_HOME`):

```sh
.venv-mlx/bin/python src/teacher_score.py        # teacher probs -> artifacts/teacher-scores-v4.jsonl
VARIANT=soft EMAIL_CLASSIFIER_TRAIN=$HOME/data/v3_full/labeled_full_train.jsonl \
EMAIL_CLASSIFIER_MODEL_DIR=$HOME/artifacts/model-v5d-soft \
EMAIL_CLASSIFIER_VERSION_PREFIX=v5d-soft \
  .venv/bin/python src/train_distill.py          # VAL-tuned student bundle
VARIANT=hard ... .venv/bin/python src/train_distill.py
.venv/bin/python src/distill_scorecard.py        # the frozen gate, once per candidate
```

### v1.5 features

`src/common.py` appends four leak-free signals to the 384-d embedding (priors computed from train rows only, frozen into the bundle so serving matches eval exactly):

- smoothed per-sender respond prior (the strongest single feature — senders Gavin has replied to before);
- log-scaled sender volume;
- bulk/newsletter flag (List-Unsubscribe header where exported, sender/snippet patterns everywhere);
- `Re:`/`Fwd:` subject flag.

## Neural candidate (eval-gated)

`src/train_neural.py` fine-tunes Qwen2.5-0.5B-Instruct with LoRA (MLX, Apple Silicon; run from `EMAIL_CLASSIFIER_HOME`'s own `.venv-mlx` — `uv venv .venv-mlx --python 3.12 && uv pip install --python .venv-mlx/bin/python mlx-lm`) as a 3-way classifier over the same prompt information, on the same split. Stages: `prep`, `train`, `eval`. The eval writes `artifacts/neural-eval.json`, which the scorecard picks up automatically.

`src/train_neural_v4.py` is the 1.5B successor (stages `prep`/`train`/`fuse`/`eval`): the v4 winner, promoted on 2026-11-19 with respond F1 0.566 vs the incumbent's 0.528. It excludes the frozen VAL carve from training, oversamples respond 20x, validates stratified per class, promotes the val-best checkpoint, tunes a respond threshold on VAL, and writes `artifacts/neural-eval-v4.json` for the scorecard. The fused model (plus `threshold.json`) is what the deployment serves.

Per the standing rule, a neural candidate deploys only if it beats the classical baseline on the same split; otherwise the numbers are reported and it stays on the laptop.

## Inference API

The served copy lives with the deployment at `deploy/email-classifier/base/api/main.py` (kustomize only loads ConfigMap sources from inside its own base). It is self-contained; its `compose_text` and feature helpers mirror `src/common.py` here — keep the two identical. It serves both bundle generations (feature-aware since v1.5), so a model-dir rollback needs no code change.

```sh
.venv/bin/uvicorn main:app --app-dir ../deploy/email-classifier/base/api --port 8080
curl -s localhost:8080/predict -H 'content-type: application/json' \
  -d '{"from": "ACME <no-reply@acme.com>", "subject": "Your order shipped", "snippet": "Your order is on the way"}'
```

Deployed to the homelab cluster from `deploy/email-classifier/` — see that directory's README for the populate-and-rollout steps (the model artifact travels out-of-band, never through this public repo).
