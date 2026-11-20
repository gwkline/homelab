"""v5 distilled classical student: teacher probs -> the ~25 ms bundle.

Distills the deployed neural-v4 teacher (Qwen2.5-1.5B LoRA, gate respond
F1 0.566, ~3 s/message) into the classical bundle shape (MiniLM embeddings
+ engineered features + fast head, ~25 ms/message) so the fallback path —
and any latency-sensitive consumer — gets neural-quality respond ranking
at classical speed.

Teacher signal: artifacts/teacher-scores-v4.jsonl under
EMAIL_CLASSIFIER_HOME, batch-scored by src/teacher_score.py (gate parity
373/373 vs the serial v4 eval). The teacher's serving threshold rides in
artifacts/neural-fused-v4/threshold.json and defines its hard decision.

Selection discipline — identical to src/train_v4.py:

  VAL   the frozen selection carve, DISTILL_VAL_IDS (default: the frozen
        2026-window row carve mine/val_ids_v4.json; the v6 retry points
        it at mine/val_ids_v6.json — the sender-disjoint whole-sender
        carve from src/carve_val_v6.py, the fix for the v5 miss where
        50 of 58 VAL senders also sat in the fit pool and the tune
        over-credited the sender-prior feature). ALL tuning lives here:
        prior window, distillation temperature, respond boost, head,
        respond threshold, calibration.
  GATE  the frozen 373-row gate_ids.json split. Promotion only, scored
        once per frozen candidate by src/distill_scorecard.py.

Variants via VARIANT env (soft | hard):

  soft  temperature-transformed teacher probabilities as targets, trained
        by sample-weight expansion — each row contributes three weighted
        (x, class) terms, which is EXACT expected cross-entropy against
        the soft targets for the logreg head — plus a respond boost on
        rows the teacher itself flags (p_respond >= its threshold). The
        boost is the v4 LoRA recipe's oversample-to-share insight: the
        pool is 3.7% respond, and an unboosted distillation trains a
        student that under-recalls exactly like the v3-full retrain did.
  hard  the teacher's serving decision (respond iff p_respond >= its
        threshold, else its best non-respond class) as labels, with the
        v4 recipe's class weights (respond x ratio-capped, mark-read x8).

Head: logistic regression (the incumbent's proven shape) by default;
DISTILL_HEAD=hist swaps in HistGradientBoosting for a VAL-side control.
Outputs the self-contained bundle (embedder snapshot + head + frozen
priors + respond threshold + Platt calibration) plus
mine/distill-val-report.json — aggregate metrics only, no message
content.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression

from common import (
    LABELS,
    TEST_CUTOFF_MS,
    home,
    is_train,
    numeric_features,
    sender_priors,
    train_path,
)
from train_v4 import (
    ARCHIVE_F1_FLOOR,
    PRIOR_WINDOWS,
    encode_cached,
    metrics,
)

TEACHER_SCORES = "teacher-scores-v4.jsonl"
TEACHER_DIR = "neural-fused-v4"
SOFT_TEMPS = [0.5, 1.0, 2.0]
SOFT_BOOSTS = [1.0, 5.0, 10.0, 20.0, 30.0]
HARD_BOOSTS = [5.0, 10.0, 20.0, 30.0]


def load_teacher() -> tuple[dict, float, str]:
    """id -> probs dict, plus the teacher's serving threshold + version."""
    path = home() / "artifacts" / TEACHER_SCORES
    scores: dict[str, dict] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            r = json.loads(line)
            scores[r["id"]] = r
    meta = json.load(open(home() / "artifacts" / TEACHER_DIR
                          / "threshold.json", encoding="utf-8"))
    return scores, float(meta["respond_threshold"]), str(meta.get("version"))


def hard_target(row_scores: dict, t: float) -> str:
    return "respond" if row_scores["p_respond"] >= t else row_scores["rest"]


def sweep_threshold(clf, X: np.ndarray, y_true: list) -> tuple[float, dict]:
    """Best raw-prob respond threshold on VAL with the archive-F1 floor —
    the exact decision rule src/train_v4.py and the serving API apply."""
    proba = clf.predict_proba(X)
    classes = [str(c) for c in clf.classes_]
    ri = classes.index("respond")
    rest_idx = [i for i, c in enumerate(classes) if c != "respond"]
    chosen_t, chosen_m = None, None
    for t in np.linspace(0.05, 0.95, 91):
        y_pred = []
        for row in proba:
            if row[ri] >= t:
                y_pred.append("respond")
            else:
                y_pred.append(classes[int(np.argmax([row[i] for i in rest_idx]))])
        m = metrics(y_true, y_pred)
        if chosen_m is None:
            chosen_t, chosen_m = float(t), m
            continue
        guard = m["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR
        best_guard = chosen_m["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR
        better = (m["respond"]["f1-score"]
                  > chosen_m["respond"]["f1-score"] + 1e-9)
        if (guard or not best_guard) and (better or (guard and not best_guard)):
            chosen_t, chosen_m = float(t), m
    assert chosen_t is not None and chosen_m is not None
    return chosen_t, chosen_m


def fit_head(head: str, X, y, sample_weight):
    if head == "hist":
        from sklearn.ensemble import HistGradientBoostingClassifier

        clf = HistGradientBoostingClassifier(
            max_iter=600, learning_rate=0.08, max_leaf_nodes=63,
            l2_regularization=1.0, early_stopping="auto",
            n_iter_no_change=50, random_state=42)
        clf.fit(X, y, sample_weight=sample_weight)
        return clf
    clf = LogisticRegression(max_iter=2000, C=1.0)
    clf.fit(X, y, sample_weight=sample_weight)
    return clf


def main() -> int:
    variant = os.environ.get("VARIANT", "soft")
    head = os.environ.get("DISTILL_HEAD", "logreg")
    if variant not in ("soft", "hard"):
        raise SystemExit(f"unknown VARIANT {variant!r}")
    emb_dir = Path(os.environ.get(
        "EMAIL_CLASSIFIER_EMBEDDER",
        home() / "artifacts" / "model" / "embedding-model"))
    out_dir = (Path(os.environ["EMAIL_CLASSIFIER_MODEL_DIR"])
               if os.environ.get("EMAIL_CLASSIFIER_MODEL_DIR")
               else home() / "artifacts" / f"model-v5d-{variant}")
    out_dir.mkdir(parents=True, exist_ok=True)
    version_prefix = os.environ.get("EMAIL_CLASSIFIER_VERSION_PREFIX",
                                    f"v5d-{variant}")

    # --- pool, VAL carve, teacher signal --------------------------------
    pool = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    pool = [r for r in pool if is_train(r)]
    val_file = Path(os.environ.get(
        "DISTILL_VAL_IDS", home() / "mine" / "val_ids_v4.json"))
    val_ids = set(json.load(open(val_file, encoding="utf-8"))["ids"])
    val = sorted((r for r in pool if r["id"] in val_ids), key=lambda r: r["d"])
    fit = [r for r in pool if r["id"] not in val_ids]
    if len(val) != len(val_ids):
        raise SystemExit(f"VAL carve drift: resolved {len(val)} of "
                          f"{len(val_ids)} ids from {val_file}")

    teacher, teacher_t, teacher_version = load_teacher()
    missing = [r["id"] for r in pool if r["id"] not in teacher]
    if missing:
        raise SystemExit(f"{len(missing)} pool rows lack teacher scores "
                          f"(first {missing[0]}); run src/teacher_score.py")

    t_resp = sum(1 for r in pool if hard_target(teacher[r["id"]], teacher_t)
                 == "respond")
    counts = {label: sum(1 for r in fit if r["label"] == label)
              for label in LABELS}
    print(f"fit rows: {len(fit)} {counts}; val rows: {len(val)}")
    print(f"teacher flags {t_resp}/{len(pool)} pool rows respond "
          f"(threshold {teacher_t}) — the distill target's share is "
          f"{t_resp / len(pool) * 100:.1f}%")

    encoder = SentenceTransformer(str(emb_dir))
    t0 = time.time()
    X_fit = encode_cached(encoder, fit, "minilm")
    X_val = encode_cached(encoder, val, "minilm")
    print(f"embedded {len(fit) + len(val)} rows in {time.time() - t0:.1f}s "
          f"({X_fit.shape[1]}d)")
    y_val = [r["label"] for r in val]

    # --- grid search on VAL ------------------------------------------------
    # Stage 1: prior window at the variant's default boost; stage 2: the
    # (temperature, boost) grid at the winning window. Every config is
    # graded by its own VAL threshold sweep — the deployment metric.
    def targets_soft(rows, temp, boost):
        """Expansion for exact expected CE: 3 weighted rows per example."""
        n = len(rows)
        p = np.asarray([[teacher[r["id"]]["p_respond"],
                         teacher[r["id"]]["p_archive"],
                         teacher[r["id"]]["p_markread"]] for r in rows],
                       dtype=np.float64)
        p_t = np.power(np.clip(p, 1e-12, 1.0), 1.0 / temp)
        p_t = p_t / p_t.sum(axis=1, keepdims=True)
        flagged = (p[:, 0] >= teacher_t).astype(np.float64)
        w = 1.0 + flagged * (boost - 1.0)
        return np.repeat(np.arange(n), 3), np.tile([0, 1, 2], n), \
            (p_t * w[:, None]).reshape(-1)

    def targets_hard(rows, boost):
        y = [hard_target(teacher[r["id"]], teacher_t) for r in rows]
        n_resp = sum(1 for c in y if c == "respond")
        return y, np.asarray(
            [boost if c == "respond" else 8.0 if c == "mark-read" else 1.0
             for c in y], dtype=np.float32), n_resp

    def run_config(priors, global_rate, seen, cfg, cfg_name):
        def feats(rows, X_emb):
            f = [numeric_features(r, priors, global_rate, seen) for r in rows]
            return np.hstack([X_emb, np.asarray(f, dtype=np.float32)])

        Xf, Xv = feats(fit, X_fit), feats(val, X_val)
        if variant == "soft":
            idx, y_exp, we = targets_soft(fit, cfg["temp"], cfg["boost"])
            Xe = Xf[idx]
            clf = fit_head(head, Xe, [LABELS[i] for i in y_exp],
                           we.astype(np.float32))
        else:
            y, w, _ = targets_hard(fit, cfg["boost"])
            clf = fit_head(head, Xf, y, w)
        t_val, m_val = sweep_threshold(clf, Xv, y_val)
        print(f"  {cfg_name:34s} val respond F1 "
              f"{m_val['respond']['f1-score']:.3f} "
              f"(P {m_val['respond']['precision']:.3f} "
              f"R {m_val['respond']['recall']:.3f}) archive F1 "
              f"{m_val['archive']['f1-score']:.3f} threshold {t_val:.2f}",
              flush=True)
        return {"cfg": dict(cfg), "name": cfg_name, "clf": clf,
                "priors": (priors, global_rate, seen),
                "threshold": t_val, "metrics": m_val}

    grid_name = (lambda c: f"T={c['temp']} w={c['boost']:.0f}")
    default_cfg = ({"temp": 1.0, "boost": 10.0} if variant == "soft"
                   else {"temp": 1.0, "boost": 20.0})
    results = []
    for wname, since in PRIOR_WINDOWS:
        prior_pool = [r for r in fit if not since or r["d"] >= since]
        if sum(1 for r in prior_pool if r["label"] == "respond") < 30:
            print(f"prior window {wname} too thin; skipped")
            continue
        priors, global_rate, seen = sender_priors(prior_pool)
        results.append(run_config(priors, global_rate, seen, default_cfg,
                                  f"[{wname}] " + grid_name(default_cfg)))
    ok = [s for s in results
          if s["metrics"]["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR]
    base = max(ok or results,
               key=lambda s: s["metrics"]["respond"]["f1-score"])
    best_window = base["name"].split("]")[0] + "]"
    best_since = next(s for n, s in PRIOR_WINDOWS if best_window == f"[{n}]")
    print(f"stage 1 winner: prior window {best_window}")

    stage2 = []
    for temp in (SOFT_TEMPS if variant == "soft" else [1.0]):
        for boost in (SOFT_BOOSTS if variant == "soft" else HARD_BOOSTS):
            cfg = {"temp": temp, "boost": boost}
            if cfg == default_cfg:
                continue  # already scored at the best window in stage 1
            prior_pool = [r for r in fit
                          if not best_since or r["d"] >= best_since]
            priors, global_rate, seen = sender_priors(prior_pool)
            stage2.append(run_config(priors, global_rate, seen, cfg,
                                     grid_name(cfg)))
    pool_res = results + stage2
    ok2 = [s for s in pool_res
           if s["metrics"]["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR]
    best = max(ok2 or pool_res,
               key=lambda s: s["metrics"]["respond"]["f1-score"])
    print(f"stage 2 winner: {best['name']} "
          f"(val respond F1 {best['metrics']['respond']['f1-score']:.3f}, "
          f"threshold {best['threshold']:.2f})")

    # --- head control at the winning config ------------------------------
    if os.environ.get("DISTILL_HEAD_CONTROL", "1") == "1" and head == "logreg":
        print(f"head control: hist at {best['name']}")
        prior_pool = [r for r in fit
                      if not best_since or r["d"] >= best_since]
        priors, global_rate, seen = sender_priors(prior_pool)
        alt = run_config(priors, global_rate, seen, best["cfg"],
                         "hist " + best["name"])
        if (alt["metrics"]["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR
                and alt["metrics"]["respond"]["f1-score"]
                > best["metrics"]["respond"]["f1-score"] + 0.02):
            print("hist head wins by >0.02 VAL F1 — adopting it")
            best, head = alt, "hist"
        else:
            print("logreg head retained")

    # --- Platt calibration + reliability bins on VAL (report only) -------
    priors, global_rate, seen = best["priors"]

    def feats_final(rows, X_emb):
        f = [numeric_features(r, priors, global_rate, seen) for r in rows]
        return np.hstack([X_emb, np.asarray(f, dtype=np.float32)])

    Xv = feats_final(val, X_val)
    proba = best["clf"].predict_proba(Xv)
    classes = [str(c) for c in best["clf"].classes_]
    p_resp = proba[:, classes.index("respond")]
    eps = 1e-9
    logits = np.log(np.clip(p_resp, eps, 1 - eps)
                    / np.clip(1 - p_resp, eps, 1 - eps))
    z = (np.asarray(y_val) == "respond").astype(float)
    lr = LogisticRegression(C=1e6, max_iter=2000)
    lr.fit(logits.reshape(-1, 1), z)
    platt = {"a": float(lr.coef_[0][0]), "b": float(lr.intercept_[0])}
    p_cal = 1.0 / (1.0 + np.exp(-(platt["a"] * logits + platt["b"])))
    bins = []
    for lo in np.linspace(0.0, 0.9, 10):
        mask = (p_cal >= lo) & (p_cal < lo + 0.1)
        if mask.sum():
            bins.append({"bin": f"{lo:.1f}-{lo + 0.1:.1f}",
                         "n": int(mask.sum()),
                         "mean_pred": round(float(p_cal[mask].mean()), 4),
                         "observed": round(float(z[mask].mean()), 4)})

    chosen_t = best["threshold"]

    # --- final refit on fit+VAL (train_v4 recipe): hyperparams, window,
    # threshold and calibration stay as selected; only the weights refit --
    pool_rows = fit + val
    X_pool = np.vstack([X_fit, X_val])
    prior_pool_full = [r for r in pool_rows
                       if not best_since or r["d"] >= best_since]
    priors_f, global_rate_f, seen_f = sender_priors(prior_pool_full)

    def feats_pool():
        f = [numeric_features(r, priors_f, global_rate_f, seen_f)
             for r in pool_rows]
        return np.hstack([X_pool, np.asarray(f, dtype=np.float32)])

    if variant == "soft":
        idx, y_exp, we = targets_soft(pool_rows, best["cfg"]["temp"],
                                      best["cfg"]["boost"])
        Xp = feats_pool()[idx]
        clf_final = fit_head(head, Xp, [LABELS[i] for i in y_exp],
                             we.astype(np.float32))
    else:
        y_pool, w_pool, _ = targets_hard(pool_rows, best["cfg"]["boost"])
        clf_final = fit_head(head, feats_pool(), y_pool, w_pool)

    counts_pool = {label: sum(1 for r in pool_rows if r["label"] == label)
                   for label in LABELS}
    print(f"final refit on fit+VAL ({len(pool_rows)} rows)")

    version = (version_prefix + "-"
               + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M"))
    emb_name = emb_dir.name
    feature_version = "v5-distill-emb+priors+bulk+reply"
    bundle = {
        "version": version,
        "clf": clf_final,
        "classes": [str(c) for c in clf_final.classes_],
        "embedding_model": "all-MiniLM-L6-v2 (v1.5 snapshot)",
        "embedding_dim": int(X_fit.shape[1]),
        "feature_version": feature_version,
        "sender_priors": priors_f,
        "sender_seen": seen_f,
        "global_rate": global_rate_f,
        "prior_window": best_window.strip("[]"),
        "respond_threshold": chosen_t,
        "platt": platt,
        "head": head,
        "distill": {
            "variant": variant,
            "teacher_version": teacher_version,
            "teacher_threshold": teacher_t,
            "temperature": best["cfg"].get("temp"),
            "respond_boost": best["cfg"]["boost"],
            "teacher_flagged_respond_pool_share":
                round(t_resp / len(pool), 4),
        },
        "test_cutoff_ms": TEST_CUTOFF_MS,
        "train_counts": counts_pool,
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    joblib.dump(bundle, out_dir / "model.joblib")
    with open(out_dir / "metadata.json", "w", encoding="utf-8") as fh:
        json.dump({
            "version": version,
            "embedding_model": "all-MiniLM-L6-v2 (v1.5 snapshot)",
            "embedding_dim": int(X_fit.shape[1]),
            "feature_version": feature_version,
            "classifier": {"logreg": "sklearn.linear_model.LogisticRegression",
                           "hist": "sklearn.ensemble.HistGradientBoosting"
                                   "Classifier"}.get(
                               head, "unknown"),
            "prior_window": bundle["prior_window"],
            "respond_threshold": chosen_t,
            "platt": platt,
            "distill": bundle["distill"],
            "features": [
                f"minilm-{X_fit.shape[1]}d",
                "sender_respond_prior_smoothed",
                "log1p_sender_seen",
                "bulk_flag",
                "reply_subject_flag",
            ],
            "test_cutoff_ms": TEST_CUTOFF_MS,
            "train_counts": counts_pool,
            "trained_at": bundle["trained_at"],
        }, fh, indent=2)

    emb_out = out_dir / "embedding-model"
    if emb_out.exists():
        shutil.rmtree(emb_out)
    encoder.save(str(emb_out))

    probs_path = (home() / "artifacts"
                  / f"distill-val-probs-{version_prefix}.json")
    with open(probs_path, "w", encoding="utf-8") as fh:
        json.dump({
            "ids": [r["id"] for r in val],
            "p_respond": [round(float(p), 6) for p in p_resp],
            "threshold": chosen_t,
        }, fh)

    report = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "variant": variant,
        "head": head,
        "teacher_version": teacher_version,
        "teacher_threshold": teacher_t,
        "teacher_flagged_respond_pool_share": round(t_resp / len(pool), 4),
        "fit_rows": len(fit),
        "fit_counts": counts,
        "val_rows": len(val),
        "val_counts": {label: y_val.count(label) for label in LABELS},
        "prior_window_sweep": [
            {"window": s["name"].split("]")[0].strip("["),
             "respond_f1": s["metrics"]["respond"]["f1-score"],
             "archive_f1": s["metrics"]["archive"]["f1-score"]}
            for s in results],
        "selected_prior_window": best_window.strip("[]"),
        "grid": [
            {"config": s["name"], "threshold": s["threshold"],
             "respond_f1": s["metrics"]["respond"]["f1-score"],
             "respond_p": s["metrics"]["respond"]["precision"],
             "respond_r": s["metrics"]["respond"]["recall"],
             "archive_f1": s["metrics"]["archive"]["f1-score"]}
            for s in pool_res],
        "selected_config": best["name"],
        "selected_temperature": best["cfg"].get("temp"),
        "selected_respond_boost": best["cfg"]["boost"],
        "respond_threshold": chosen_t,
        "platt": platt,
        "reliability_bins_val": bins,
        "final_refit_rows": len(pool_rows),
        "final_refit_counts": counts_pool,
        "note": "selection on the frozen VAL carve only (temperature, "
                "boost, prior window, threshold, head); the frozen gate "
                "is scored once by src/distill_scorecard.py after this "
                "run. Final weights refit on fit+VAL per the train_v4 "
                "recipe; threshold and calibration stay as selected.",
    }
    report_path = (home() / "mine"
                   / f"distill-val-report-{version_prefix}.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"saved {out_dir / 'model.joblib'} ({version})")
    print(f"report -> {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
