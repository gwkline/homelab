"""Era-stratified diagnostics for the full-history labels (DIAGNOSTIC ONLY).

The promotion gate stays the fixed recent held-out split; nothing here
feeds promotion. This script answers two questions the gate cannot:

 1. Label drift — how do the behavior class shares move across eras
    (respond rate by year bucket)? Behavioral drift across years is
    expected; the point is to report it, not hide it.
 2. Era performance — does a model trained on the SAME recipe transfer
    across eras? Carves a deterministic per-era validation slice out of
    the v3 train rows, retrains MiniLM+priors+bulk+reply on the rest,
    and scores the slice per era and per class.

Outputs eval/era-report.md (aggregate metrics only) and
$EMAIL_CLASSIFIER_HOME/mine/era_eval.json.
"""

from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report

from common import (
    LABELS,
    TEST_CUTOFF_MS,
    compose_text,
    data_dir,
    embedding_model_path,
    home,
    numeric_features,
    sender_priors,
)

ERA_BUCKETS = [
    ("pre-2018", 0, 2018),
    ("2018-2020", 2018, 2021),
    ("2021-2023", 2021, 2024),
    ("2024-2026", 2024, 2026),
]
CARVE_PER_ERA = 1500
MIN_CARVE = 200


def bucket_of(era: int) -> str:
    for name, lo, hi in ERA_BUCKETS:
        if lo <= era < hi:
            return name
    return "unknown"


def load_train_v3():
    path = data_dir() / "labeled_v3_train.jsonl"
    return [json.loads(line) for line in open(path, encoding="utf-8")]


def main() -> int:
    rows = load_train_v3()
    for r in rows:
        r["bucket"] = bucket_of(r.get("era") or
                                datetime.fromtimestamp(
                                    r["d"] / 1000, tz=timezone.utc).year)

    # ---- 1. label drift ------------------------------------------------
    drift = {}
    for name, _lo, _hi in ERA_BUCKETS:
        sub = [r for r in rows if r["bucket"] == name]
        n = len(sub)
        per = {label: sum(1 for r in sub if r["label"] == label)
               for label in LABELS}
        drift[name] = {
            "rows": n,
            "per_class": per,
            "respond_share": round(per["respond"] / n, 4) if n else None,
        }

    # ---- 2. era carve-out scorecard ------------------------------------
    rng = random.Random(20261119)
    carve, fit = [], []
    for name, _lo, _hi in ERA_BUCKETS:
        sub = sorted((r for r in rows if r["bucket"] == name),
                     key=lambda r: r["d"])
        if len(sub) >= MIN_CARVE:
            k = min(CARVE_PER_ERA, max(MIN_CARVE, len(sub) // 5))
            take = set(rng.sample(range(len(sub)), k))
            carve.extend(sub[i] for i in take)
            fit.extend(sub[i] for i in range(len(sub)) if i not in take)
        else:
            carve.extend(sub)  # too small to split: diagnose on all of it

    if len(fit) < 500:
        raise SystemExit("carve train set too small; not enough v3 data yet")

    counts = {label: sum(1 for r in fit if r["label"] == label)
              for label in LABELS}
    if min(counts.values()) == 0:
        raise SystemExit(f"empty class in carve fit: {counts}")

    encoder = SentenceTransformer(str(embedding_model_path()))
    priors, global_rate, seen = sender_priors(fit)

    def featurize(rs):
        X = encoder.encode(
            [compose_text(r["from"], r["subject"], r["snippet"]) for r in rs],
            batch_size=64, normalize_embeddings=True, show_progress_bar=False)
        feats = [numeric_features(r, priors, global_rate, seen) for r in rs]
        return np.hstack([X, np.asarray(feats, dtype=np.float32)])

    clf = LogisticRegression(class_weight="balanced", max_iter=2000, C=1.0)
    clf.fit(featurize(fit), [r["label"] for r in fit])

    results = {}
    for name, _lo, _hi in ERA_BUCKETS:
        sub = [r for r in carve if r["bucket"] == name]
        if not sub:
            continue
        y_true = [r["label"] for r in sub]
        y_pred = clf.predict(featurize(sub))
        rep = classification_report(
            y_true, y_pred, labels=LABELS, digits=3,
            zero_division=0, output_dict=True)
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
        "cutoff_ms": TEST_CUTOFF_MS,
        "fit_rows": len(fit),
        "carve_rows": len(carve),
        "note": "diagnostic only; promotion gate is the fixed recent split",
        "label_drift": drift,
        "era_scorecard": results,
    }
    mine = home() / "mine"
    with open(mine / "era_eval.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)

    lines = ["# Email action classifier — era diagnostics (v3 history)",
             "",
             "_DIAGNOSTIC ONLY — the promotion gate is the fixed recent "
             "held-out split and stays untouched. Aggregate metrics only._",
             "",
             "## Label drift across eras (train rows)",
             "",
             "| era | rows | respond | archive | mark-read | respond share |",
             "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for name, _lo, _hi in ERA_BUCKETS:
        d = drift[name]
        if d["rows"]:
            per = d["per_class"]
            lines.append(
                f"| {name} | {d['rows']} | {per['respond']} | "
                f"{per['archive']} | {per['mark-read']} | "
                f"{d['respond_share']:.3f} |")
    lines += ["", "## Carve-out scorecard per era",
              f"(fit {len(fit)} rows, carve {len(carve)}; same recipe)",
              "",
              "| era | n | acc | respond P/R/F1 | resp support | archive F1 |",
              "| --- | ---: | ---: | --- | ---: | ---: |"]
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
    report = home() / "eval" / "era-report.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    with open(report, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    repo_report = Path(__file__).resolve().parent.parent / "evals" / "era-report.md"
    repo_report.parent.mkdir(parents=True, exist_ok=True)
    with open(repo_report, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {repo_report} and {report} and {mine / 'era_eval.json'}")
    for name in results:
        print(name, json.dumps(results[name]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
