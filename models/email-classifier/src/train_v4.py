"""v4 classical candidate: upgraded embedder + GBDT head, eval-gated.

Contested against the incumbent v1.5 on the frozen gate via
src/scorecard.py — never inside this script:

  embedder  a modern local encoder (BAAI/bge-base-en-v1.5 /
            Qwen3-Embedding-0.6B class) replaces MiniLM-L6;
  head      xgboost GBDT with class weights (respond rarity) replaces
            logistic regression. A logreg head on the SAME embedder is
            the control that isolates the embedder effect.

Selection discipline — the gate is scored once per frozen candidate,
after all tuning is done:

  VAL   deterministic 2026-window carve out of the v3 train pool: every
        pre-cutoff 2026 respond row plus a stride-matched archive sample
        (ids frozen in mine/val_ids_v4.json so the neural lane excludes
        the same rows). Era- and prevalence-matched to the gate window.
        ALL selection lives here: prior window, calibration, threshold.
  GATE  the frozen 373-row gate_ids.json split. Promotion only, one shot.

Outputs: EMAIL_CLASSIFIER_MODEL_DIR bundle (self-contained: embedder
snapshot + head + priors + Platt calibration + respond threshold) and
mine/v4-val-report.json (aggregate metrics + counts only, no message
content).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report

from common import (
    LABELS,
    TEST_CUTOFF_MS,
    compose_text,
    data_dir,
    home,
    is_train,
    numeric_features,
    sender_priors,
    train_path,
)

# VAL carve: the gate is the newest ~2 months at ~4.8% respond; the 2026
# pre-cutoff pool window holds 27 respond rows across ~8.5k rows, so a
# stride-29 archive sample reproduces the gate's respond:archive ratio
# (~1:20) deterministically. 2024+ windows carry older behavior; the
# 2026 window is the honest era proxy.
VAL_SINCE_MS = 1767225600000  # 2026-01-01T00:00:00Z
VAL_ARCHIVE_STRIDE = 29
ARCHIVE_F1_FLOOR = 0.90

PRIOR_WINDOWS = [
    ("all", 0),
    ("2024+", 1704067200000),  # 2024-01-01
    ("2026+", 1767225600000),  # 2026-01-01
]

ERA_BUCKETS = [
    ("pre-2018", 0, 2018),
    ("2018-2020", 2018, 2021),
    ("2021-2023", 2021, 2024),
    ("2024-2025", 2024, 2026),
    ("2026", 2026, 2027),
]


def era_bucket(ms: int) -> str:
    year = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).year
    for name, lo, hi in ERA_BUCKETS:
        if lo <= year < hi:
            return name
    return "unknown"


def carve_val(pool: list) -> list:
    """Deterministic VAL carve; also freezes the ids for the neural lane."""
    val_path = home() / "mine" / "val_ids_v4.json"
    ids = None
    if val_path.exists():
        ids = set(json.load(open(val_path))["ids"])
    window = [r for r in pool if VAL_SINCE_MS <= r["d"] < TEST_CUTOFF_MS]
    respond = sorted((r for r in window if r["label"] == "respond"),
                     key=lambda r: r["d"])
    archives = sorted((r for r in window if r["label"] == "archive"),
                     key=lambda r: r["d"])
    if ids is None:
        val = respond + archives[::VAL_ARCHIVE_STRIDE]
        val_path.parent.mkdir(parents=True, exist_ok=True)
        with open(val_path, "w", encoding="utf-8") as fh:
            json.dump({
                "ids": [r["id"] for r in sorted(val, key=lambda r: r["d"])],
                "respond": len(respond),
                "archive": len(archives[::VAL_ARCHIVE_STRIDE]),
                "since_ms": VAL_SINCE_MS,
                "archive_stride": VAL_ARCHIVE_STRIDE,
                "note": "v4 selection carve from the v3 train pool; "
                        "gate and #526 batch excluded by construction",
            }, fh)
        ids = set(json.load(open(val_path))["ids"])
        print(f"froze VAL carve: {len(ids)} ids -> {val_path}")
    return sorted((r for r in window if r["id"] in ids), key=lambda r: r["d"])


def class_weights(y: list) -> list:
    """respond x~archive/respond ratio (cap 30), mark-read x8 (the neural
    recipe's oversample factors, expressed as weights)."""
    counts = {label: y.count(label) for label in LABELS}
    w_resp = min(30.0, counts["archive"] / max(counts["respond"], 1))
    return {label: ({ "respond": w_resp, "mark-read": 8.0 }.get(label, 1.0))
            for label in LABELS}


def encode_cached(encoder, rows, key: str):
    """Embed with a per-id cache: the pool is static, so repeat runs and
    head variants never pay for the same text twice."""
    cache_dir = home() / "artifacts" / "emb-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{key}.npz"
    ids = [r["id"] for r in rows]
    have: dict = {}
    if cache.exists():
        z = np.load(cache, allow_pickle=False)
        for i, row in zip(z["ids"], z["X"]):
            have[str(i)] = row  # keep ALL cached rows, not just this call's
    missing = [r for r in rows if r["id"] not in have]
    if missing:
        fresh = encoder.encode(
            [compose_text(r["from"], r["subject"], r["snippet"])
             for r in missing],
            batch_size=64, normalize_embeddings=True, show_progress_bar=False)
        for r, row in zip(missing, fresh):
            have[r["id"]] = row
        np.savez(cache, ids=np.asarray(sorted(have.keys())),
                 X=np.stack([have[i] for i in sorted(have.keys())]))
    return np.stack([have[i] for i in ids]).astype(np.float32)


def metrics(y_true: list, y_pred: list) -> dict:
    rep = classification_report(
        y_true, y_pred, labels=LABELS, digits=3, zero_division=0,
        output_dict=True)
    out = {"accuracy": round(float(np.mean(np.asarray(y_pred) == np.asarray(y_true))), 4)}
    for label in LABELS:
        if label in rep and rep[label]["support"]:
            out[label] = {k: round(rep[label][k], 4) for k in ("precision", "recall", "f1-score")}
            out[label]["support"] = int(rep[label]["support"])
    return out


def main() -> int:
    head = os.environ.get("V4_HEAD", "gbdt")
    embedder_dir = Path(os.environ["EMAIL_CLASSIFIER_EMBEDDER"])
    out_dir = (Path(os.environ["EMAIL_CLASSIFIER_MODEL_DIR"])
               if os.environ.get("EMAIL_CLASSIFIER_MODEL_DIR")
               else home() / "artifacts" / "model-v4")
    out_dir.mkdir(parents=True, exist_ok=True)

    pool = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    pool = [r for r in pool if is_train(r)]
    val = carve_val(pool)
    val_ids = {r["id"] for r in val}
    fit = [r for r in pool if r["id"] not in val_ids]

    counts = {label: sum(1 for r in fit if r["label"] == label) for label in LABELS}
    print(f"fit rows: {len(fit)} (respond {counts['respond']}, "
          f"archive {counts['archive']}, mark-read {counts['mark-read']})")
    print(f"val rows: {len(val)} (respond {sum(1 for r in val if r['label'] == 'respond')})")

    encoder = SentenceTransformer(str(embedder_dir))
    t0 = time.time()
    X_fit = encode_cached(encoder, fit, embedder_dir.name)
    X_val = encode_cached(encoder, val, embedder_dir.name)
    print(f"embedded {len(fit) + len(val)} texts in {time.time() - t0:.1f}s "
          f"({X_fit.shape[1]}d, cache {embedder_dir.name})")
    y_val = [r["label"] for r in val]

    # --- prior-window sweep on VAL (leak-free: priors from FIT rows only) ---
    sweep = []
    for wname, since in PRIOR_WINDOWS:
        prior_pool = [r for r in fit if not since or r["d"] >= since]
        if sum(1 for r in prior_pool if r["label"] == "respond") < 30:
            print(f"prior window {wname} too thin; skipped")
            continue
        priors, global_rate, seen = sender_priors(prior_pool)

        def featurize(rows, X_emb):
            feats = [numeric_features(r, priors, global_rate, seen) for r in rows]
            return np.hstack([X_emb, np.asarray(feats, dtype=np.float32)])

        if head == "gbdt":
            from xgboost import XGBClassifier
            w = class_weights([r["label"] for r in fit])
            sw = np.asarray([w[r["label"]] for r in fit], dtype=np.float32)
            clf = XGBClassifier(
                n_estimators=600, max_depth=6, learning_rate=0.08,
                subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0,
                tree_method="hist",
                # no explicit objective: the sklearn wrapper infers
                # multi:softprob AND label-encodes string y itself — an
                # explicit multi:softprob flips it into integer-label
                # validation ("Expected: [0 1 2]") and rejects the
                # string classes.
                eval_metric="mlogloss",
                early_stopping_rounds=50, random_state=42, n_jobs=4,
            )
            clf.fit(featurize(fit, X_fit), [r["label"] for r in fit],
                    sample_weight=sw,
                    eval_set=[(featurize(val, X_val), y_val)],
                    sample_weight_eval_set=[
                        (np.asarray([w[r["label"]] for r in val],
                                    dtype=np.float32),)])
        elif head == "hist":
            from sklearn.ensemble import HistGradientBoostingClassifier
            w = class_weights([r["label"] for r in fit])
            clf = HistGradientBoostingClassifier(
                max_iter=600, learning_rate=0.08, max_leaf_nodes=63,
                l2_regularization=1.0, early_stopping="auto",
                n_iter_no_change=50, random_state=42)
            clf.fit(featurize(fit, X_fit), [r["label"] for r in fit],
                    sample_weight=np.asarray(
                        [w[r["label"]] for r in fit], dtype=np.float32))
        else:
            clf = LogisticRegression(class_weight="balanced",
                                     max_iter=2000, C=1.0)
            clf.fit(featurize(fit, X_fit), [r["label"] for r in fit])

        y_pred = [str(p) for p in clf.predict(featurize(val, X_val))]
        m = metrics(y_val, y_pred)
        sweep.append({"prior_window": wname, "since": since,
                      "priors": (priors, global_rate, seen),
                      "clf": clf, "metrics": m})
        print(f"prior window {wname}: val respond F1 {m['respond']['f1-score']:.3f} "
              f"(P {m['respond']['precision']:.3f} R {m['respond']['recall']:.3f}) "
              f"archive F1 {m['archive']['f1-score']:.3f}")

    ok = [s for s in sweep if s["metrics"]["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR]
    best = max(ok or sweep, key=lambda s: s["metrics"]["respond"]["f1-score"])
    priors, global_rate, seen = best["priors"]
    clf = best["clf"]
    print(f"selected prior window: {best['prior_window']}")

    # re-featurize with the selected window for calibration/threshold work
    def feats_final(rows, X_emb):
        f = [numeric_features(r, priors, global_rate, seen) for r in rows]
        return np.hstack([X_emb, np.asarray(f, dtype=np.float32)])

    Xv = feats_final(val, X_val)
    proba = clf.predict_proba(Xv)
    classes = [str(c) for c in clf.classes_]
    ri = classes.index("respond")
    p_resp = proba[:, ri]

    # --- Platt calibration for p(respond), fit on VAL -------------------
    eps = 1e-9
    logits = np.log(np.clip(p_resp, eps, 1 - eps) /
                    np.clip(1 - p_resp, eps, 1 - eps))
    z = (np.asarray(y_val) == "respond").astype(float)
    lr = LogisticRegression(C=1e6, max_iter=2000)
    lr.fit(logits.reshape(-1, 1), z)
    platt = {"a": float(lr.coef_[0][0]), "b": float(lr.intercept_[0])}
    p_cal = 1.0 / (1.0 + np.exp(-(platt["a"] * logits + platt["b"])))

    # --- respond threshold sweep on VAL ---------------------------------
    rows_best, chosen_t, chosen_m = None, None, None
    for t in np.linspace(0.05, 0.95, 91):
        rest_idx = [i for i, c in enumerate(classes) if c != "respond"]
        y_pred = []
        for row in proba:
            if row[ri] >= t:  # raw-prob threshold; Platt only reports
                y_pred.append("respond")
            else:
                y_pred.append(classes[int(np.argmax([row[i] for i in rest_idx]))])
        m = metrics(y_val, y_pred)
        if chosen_m is None:
            rows_best, chosen_t, chosen_m = m, float(t), m
            continue
        guard = m["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR
        best_guard = chosen_m["archive"]["f1-score"] >= ARCHIVE_F1_FLOOR
        better = m["respond"]["f1-score"] > chosen_m["respond"]["f1-score"] + 1e-9
        if (guard or not best_guard) and (better or (guard and not best_guard)):
            rows_best, chosen_t, chosen_m = m, float(t), m
    print(f"chosen respond threshold: {chosen_t:.2f} "
          f"(val respond F1 {chosen_m['respond']['f1-score']:.3f}, "
          f"archive F1 {chosen_m['archive']['f1-score']:.3f})")

    # reliability bins on VAL for the calibration report
    bins = []
    for lo in np.linspace(0.0, 0.9, 10):
        mask = (p_cal >= lo) & (p_cal < lo + 0.1)
        if mask.sum():
            bins.append({"bin": f"{lo:.1f}-{lo + 0.1:.1f}", "n": int(mask.sum()),
                         "mean_pred": round(float(p_cal[mask].mean()), 4),
                         "observed": round(float(z[mask].mean()), 4)})

    # --- VAL probs for the ensemble lane (honest: fit-only model) --------
    probs_path = home() / "artifacts" / "v4-val-probs.json"
    vp = json.load(open(probs_path)) if probs_path.exists() else {}
    vp[f"{embedder_dir.name}-{head}"] = {
        "ids": [r["id"] for r in val],
        "p_respond": [round(float(p), 6) for p in p_resp],
        "threshold": chosen_t,
    }
    with open(probs_path, "w", encoding="utf-8") as fh:
        json.dump(vp, fh)

    # --- final refit on fit+VAL: the era-recent respond rows are the most
    # era-relevant examples in the corpus, so the deployed model trains on
    # the full pool even though selection kept VAL out. Hyperparams, prior
    # window, threshold and calibration stay as selected; only the weights
    # refit. --------------------------------------------------------------
    best_since = best["since"]
    pool_rows = fit + val
    X_pool = np.vstack([X_fit, X_val])
    counts_pool = {label: sum(1 for r in pool_rows if r["label"] == label)
                   for label in LABELS}
    prior_pool_full = [r for r in pool_rows
                       if not best_since or r["d"] >= best_since]
    priors_f, global_rate_f, seen_f = sender_priors(prior_pool_full)

    def feats_pool():
        f = [numeric_features(r, priors_f, global_rate_f, seen_f)
             for r in pool_rows]
        return np.hstack([X_pool, np.asarray(f, dtype=np.float32)])

    y_pool = [r["label"] for r in pool_rows]
    if head == "gbdt":
        from xgboost import XGBClassifier
        params = {k: v for k, v in clf.get_params().items()
                  if k not in ("early_stopping_rounds", "num_class")}
        if getattr(clf, "best_iteration", None):
            params["n_estimators"] = clf.best_iteration + 1
        clf_final = XGBClassifier(**params)
        w = class_weights(y_pool)
        clf_final.fit(
            feats_pool(), y_pool,
            sample_weight=np.asarray([w[r["label"]] for r in pool_rows],
                                     dtype=np.float32))
    elif head == "hist":
        from sklearn.ensemble import HistGradientBoostingClassifier
        clf_final = HistGradientBoostingClassifier(**clf.get_params())
        w = class_weights(y_pool)
        clf_final.fit(
            feats_pool(), y_pool,
            sample_weight=np.asarray([w[r["label"]] for r in pool_rows],
                                     dtype=np.float32))
    else:
        clf_final = LogisticRegression(class_weight="balanced",
                                        max_iter=2000, C=1.0)
        clf_final.fit(feats_pool(), y_pool)
    print(f"final refit on fit+VAL ({len(pool_rows)} rows, "
          f"priors window {best['prior_window']})")

    # --- examples used, per class and era (aggregate only) ---------------
    used = {"fit": {}, "val": {}}
    for name, rows in (("fit", fit), ("val", val)):
        for bucket, lo, hi in ERA_BUCKETS:
            sub = [r for r in rows if era_bucket(r["d"]) == bucket]
            used[name][bucket] = {label: sum(1 for r in sub if r["label"] == label)
                                  for label in LABELS}
            used[name][bucket]["total"] = len(sub)

    version = (os.environ.get("EMAIL_CLASSIFIER_VERSION_PREFIX", "v4")
               + "-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M"))
    emb_name = embedder_dir.name
    feature_version = "v4-emb-upgrade+priors+bulk+reply"
    bundle = {
        "version": version,
        "clf": clf_final,
        "classes": list(clf.classes_),
        "embedding_model": emb_name,
        "embedding_dim": int(X_fit.shape[1]),
        "feature_version": feature_version,
        "sender_priors": priors_f,
        "sender_seen": seen_f,
        "global_rate": global_rate_f,
        "prior_window": best["prior_window"],
        "respond_threshold": chosen_t,
        "platt": platt,
        "head": head,
        "test_cutoff_ms": TEST_CUTOFF_MS,
        "train_counts": counts_pool,
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    joblib.dump(bundle, out_dir / "model.joblib")
    with open(out_dir / "metadata.json", "w", encoding="utf-8") as fh:
        json.dump({
            "version": version,
            "embedding_model": emb_name,
            "embedding_dim": int(X_fit.shape[1]),
            "feature_version": feature_version,
            "classifier": {
                "gbdt": "xgboost.XGBClassifier",
                "hist": "sklearn.ensemble.HistGradientBoostingClassifier",
            }.get(head, "sklearn.linear_model.LogisticRegression"),
            "prior_window": best["prior_window"],
            "respond_threshold": chosen_t,
            "platt": platt,
            "features": [
                f"{emb_name}-{X_fit.shape[1]}d",
                "sender_respond_prior_smoothed",
                "log1p_sender_seen",
                "bulk_flag",
                "reply_subject_flag",
            ],
            "test_cutoff_ms": TEST_CUTOFF_MS,
            "train_counts": counts_pool,
            "trained_at": bundle["trained_at"],
        }, fh, indent=2)

    # self-contained embedder snapshot for serving (pruned via ST save)
    emb_out = out_dir / "embedding-model"
    if emb_out.exists():
        shutil.rmtree(emb_out)
    encoder.save(str(emb_out))

    report = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "embedder": emb_name,
        "head": head,
        "fit_rows": len(fit),
        "fit_counts": counts,
        "final_refit_rows": len(pool_rows),
        "final_refit_counts": counts_pool,
        "val_rows": len(val),
        "val_counts": {label: sum(1 for r in val if r["label"] == label)
                       for label in LABELS},
        "prior_window_sweep": [
            {"window": s["prior_window"],
             "respond_f1": s["metrics"]["respond"]["f1-score"],
             "archive_f1": s["metrics"]["archive"]["f1-score"]}
            for s in sweep],
        "selected_prior_window": best["prior_window"],
        "respond_threshold": chosen_t,
        "platt": platt,
        "reliability_bins_val": bins,
        "examples_used": used,
        "note": "selection on the 2026-window VAL carve only; the frozen "
                "gate is scored once by src/scorecard.py after this run",
    }
    with open(home() / "mine" / "v4-val-report.json", "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"saved {out_dir / 'model.joblib'} ({version})")
    print(f"report -> {home() / 'mine' / 'v4-val-report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
