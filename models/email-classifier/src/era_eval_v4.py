"""Era-stratified diagnostics for the v4 winner recipe (DIAGNOSTIC ONLY).

Identical carve discipline to src/era_eval.py (same rng seed 20261119,
same era buckets, caps and floors) so the carve ids are the same rows;
the only change is the recipe being scored: the v4 bundle's embedder,
prior window and head. The promotion gate stays the frozen recent split;
nothing here feeds promotion.

Env: ERA_V4_BUNDLE (default artifacts/model-v4bge-gbdt).

Outputs eval/era-report-v4.md and mine/era_eval_v4.json (aggregate
metrics only, no message content).
"""

from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics import classification_report

from common import (
    LABELS,
    compose_text,
    data_dir,
    home,
    numeric_features,
    sender_priors,
)

ERA_BUCKETS = [
    ("pre-2018", 0, 2018),
    ("2018-2020", 2018, 2021),
    ("2021-2023", 2021, 2024),
    ("2024-2026", 2024, 2027),  # hi is EXCLUSIVE: 2026-era rows land here
]
CARVE_PER_ERA = 1500
PRIOR_WINDOWS = {"all": 0, "2024+": 1704067200000, "2026+": 1767225600000}


def bucket_of(era: int) -> str:
    for name, lo, hi in ERA_BUCKETS:
        if lo <= era < hi:
            return name
    return "unknown"


def class_weights(y: list) -> dict:
    counts = {label: y.count(label) for label in LABELS}
    w_resp = min(30.0, counts["archive"] / max(counts["respond"], 1))
    return {"respond": w_resp, "mark-read": 8.0, "archive": 1.0}


def main() -> int:
    import os

    bundle_dir = (Path(os.environ.get("ERA_V4_BUNDLE"))
                  if os.environ.get("ERA_V4_BUNDLE")
                  else home() / "artifacts" / "model-v4bge-gbdt")
    bundle = joblib.load(bundle_dir / "model.joblib")
    clf = bundle["clf"]
    head = bundle.get("head", "gbdt")
    since = PRIOR_WINDOWS.get(bundle.get("prior_window", "all"), 0)

    rows = [json.loads(line)
            for line in open(data_dir() / "labeled_v3_train.jsonl",
                             encoding="utf-8")]
    for r in rows:
        year = datetime.fromtimestamp(r["d"] / 1000, tz=timezone.utc).year
        r["bucket"] = bucket_of(year)

    rng = random.Random(20261119)
    carve, fit = [], []

    def carve_class(sub, frac, cap, floor):
        sub = sorted(sub, key=lambda r: r["d"])
        if len(sub) < floor:
            return [], sub
        k = min(cap, max(1, int(len(sub) * frac)))
        take = set(rng.sample(range(len(sub)), k))
        return [sub[i] for i in take], [sub[i] for i in range(len(sub))
                                        if i not in take]

    for name, _lo, _hi in ERA_BUCKETS:
        bucket = [r for r in rows if r["bucket"] == name]
        for label in ("respond", "archive"):
            c, f = carve_class([r for r in bucket if r["label"] == label],
                               frac=0.2, cap=CARVE_PER_ERA // 2, floor=40)
            carve.extend(c)
            fit.extend(f)
        fit.extend(r for r in bucket if r["label"] == "mark-read")

    counts = {label: sum(1 for r in fit if r["label"] == label)
              for label in LABELS}
    if len(fit) < 500 or min(counts.values()) == 0:
        raise SystemExit(f"carve fit set unusable: {len(fit)} rows {counts}")

    encoder = SentenceTransformer(str(bundle_dir / "embedding-model"))
    prior_pool = [r for r in fit if not since or r["d"] >= since]
    priors, global_rate, seen = sender_priors(prior_pool)

    def featurize(rs):
        X = encoder.encode(
            [compose_text(r["from"], r["subject"], r["snippet"]) for r in rs],
            batch_size=64, normalize_embeddings=True, show_progress_bar=False)
        feats = [numeric_features(r, priors, global_rate, seen) for r in rs]
        return np.hstack([X, np.asarray(feats, dtype=np.float32)])

    y_fit = [r["label"] for r in fit]
    if head == "gbdt":
        from xgboost import XGBClassifier
        params = {k: v for k, v in clf.get_params().items()
                  if k != "early_stopping_rounds"}
        clf_v = XGBClassifier(**params)
        w = class_weights(y_fit)
        clf_v.fit(featurize(fit), y_fit,
                  sample_weight=np.asarray([w[r["label"]] for r in fit],
                                           dtype=np.float32))
    else:
        from sklearn.linear_model import LogisticRegression
        clf_v = LogisticRegression(class_weight="balanced",
                                   max_iter=2000, C=1.0)
        clf_v.fit(featurize(fit), y_fit)

    results = {}
    for name, _lo, _hi in ERA_BUCKETS:
        sub = [r for r in carve if r["bucket"] == name]
        if not sub:
            continue
        y_true = [r["label"] for r in sub]
        y_pred = [str(p) for p in clf_v.predict(featurize(sub))]
        rep = classification_report(y_true, y_pred, labels=LABELS,
                                    digits=3, zero_division=0, output_dict=True)
        results[name] = {
            "n": len(sub),
            "accuracy": round(float((np.asarray(y_pred) ==
                                     np.asarray(y_true)).mean()), 3),
            "respond": {k: round(rep["respond"][k], 3)
                        for k in ("precision", "recall", "f1-score")},
            "respond_support": int(rep["respond"]["support"]),
            "archive_f1": round(rep["archive"]["f1-score"], 3),
        }

    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "bundle": str(bundle_dir.name),
        "embedder": bundle.get("embedding_model"),
        "head": head,
        "prior_window": bundle.get("prior_window"),
        "fit_rows": len(fit),
        "carve_rows": len(carve),
        "note": "diagnostic only; same carve ids as era_eval.py, v4 recipe",
        "era_scorecard": results,
    }
    with open(home() / "mine" / "era_eval_v4.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    lines = [
        "# Email action classifier — era diagnostics (v4 recipe)",
        "",
        "_DIAGNOSTIC ONLY — the promotion gate is the fixed recent "
        "held-out split and stays untouched. Aggregate metrics only._",
        "",
        f"_Recipe: `{bundle.get('embedding_model')}` embedder + {head} head, "
        f"prior window `{bundle.get('prior_window')}`; same carve ids as the "
        "v3 era report (rng 20261119)._",
        "",
        "## Carve-out scorecard per era",
        f"(fit {len(fit)} rows, carve {len(carve)})",
        "",
        "| era | n | acc | respond P/R/F1 | resp support | archive F1 |",
        "| --- | ---: | ---: | --- | ---: | ---: |",
    ]
    for name, _lo, _hi in ERA_BUCKETS:
        if name not in results:
            continue
        r = results[name]
        resp = r["respond"]
        lines.append(
            f"| {name} | {r['n']} | {r['accuracy']:.3f} | "
            f"{resp['precision']:.3f}/{resp['recall']:.3f}/"
            f"{resp['f1-score']:.3f} | {r['respond_support']} | "
            f"{r['archive_f1']:.3f} |")
    lines += ["",
              "Small respond supports in old eras make those F1s noisy — "
              "read them as directional, not precise. The promotion "
              "decision never uses this table."]
    report = home() / "eval" / "era-report-v4.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    with open(report, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    repo_report = Path(__file__).resolve().parent.parent / "evals" / "era-report-v4.md"
    with open(repo_report, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {repo_report} and {report} and "
          f"{home() / 'mine' / 'era_eval_v4.json'}")
    for name in results:
        print(name, json.dumps(results[name]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
