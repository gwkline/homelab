"""Ensemble v4: blend classical + neural respond probabilities.

Stacked on the frozen VAL carve only (both models trained WITHOUT those
rows, so their VAL probabilities are honest out-of-sample numbers):
sweep the blend weight over p_ens = w*p_classical + (1-w)*p_neural and
the respond threshold jointly, under the same archive-F1 guardrail. The
frozen gate is then scored once; below threshold, the classical head's
argmax over the non-respond classes decides.

Env: ENSEMBLE_CLASSICAL (bundle dir; default the first artifacts/
model-v4* dir), ENSEMBLE_NEURAL (eval json; default neural-eval-v4.json).

Writes artifacts/ensemble-eval-v4.json (ids + y_pred for the scorecard)
and mine/ensemble-v4-report.json.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics import classification_report

from common import (
    LABELS,
    compose_text,
    is_test,
    labeled_path,
    numeric_features,
)

ARCHIVE_F1_FLOOR = 0.90


def metrics(y_true, y_pred) -> dict:
    rep = classification_report(y_true, y_pred, labels=LABELS,
                                digits=4, zero_division=0, output_dict=True)
    return {
        "respond_f1": round(rep["respond"]["f1-score"], 4),
        "respond_p": round(rep["respond"]["precision"], 4),
        "respond_r": round(rep["respond"]["recall"], 4),
        "archive_f1": round(rep["archive"]["f1-score"], 4),
        "accuracy": round(float(np.mean(np.asarray(y_pred) ==
                                       np.asarray(y_true))), 4),
    }


def main() -> int:
    home = Path(os.environ["EMAIL_CLASSIFIER_HOME"])
    artifacts = home / "artifacts"
    classical_dir = (Path(os.environ["ENSEMBLE_CLASSICAL"])
                     if os.environ.get("ENSEMBLE_CLASSICAL")
                     else sorted(artifacts.glob("model-v4*"))[0])
    neural_json = (Path(os.environ["ENSEMBLE_NEURAL"])
                    if os.environ.get("ENSEMBLE_NEURAL")
                    else artifacts / "neural-eval-v4.json")

    # ---- VAL probabilities (out-of-sample for both lanes) ---------------
    vp = json.load(open(artifacts / "v4-val-probs.json"))
    npv = json.load(open(artifacts / "v4-neural-val-probs.json"))
    key = [k for k in vp if vp[k]["ids"] == npv["ids"]]
    if not key:
        raise SystemExit("classical/neural VAL ids do not align")
    p_c = np.asarray(vp[key[0]]["p_respond"])
    p_n = np.asarray(npv["p_respond"])
    val_ids = np.asarray(vp[key[0]]["ids"])

    pool = [json.loads(line)
            for line in open(home / "data" / "labeled_v3_train.jsonl",
                             encoding="utf-8")]
    id_to_label = {r["id"]: r["label"] for r in pool}
    y_val = [id_to_label[i] for i in val_ids]

    # classical rest-argmax on VAL for the below-threshold fallback
    bundle = joblib.load(classical_dir / "model.joblib")
    rest_val = classical_rest_pred(classical_dir, bundle,
                                   [i for i in val_ids],
                                   {r["id"]: r for r in pool})

    best = None
    for w in np.linspace(0.0, 1.0, 21):
        p_ens = w * p_c + (1.0 - w) * p_n
        for t in np.linspace(0.05, 0.95, 91):
            y_pred = ["respond" if p >= t else rest_val[i]
                      for i, p in enumerate(p_ens)]
            m = metrics(y_val, y_pred)
            guard = m["archive_f1"] >= ARCHIVE_F1_FLOOR
            if best is None or (
                (guard and not best[0]["archive_f1"] >= ARCHIVE_F1_FLOOR)
                or (guard == (best[0]["archive_f1"] >= ARCHIVE_F1_FLOOR)
                    and m["respond_f1"] > best[0]["respond_f1"])
            ):
                best = (m, float(w), float(t))
    m, w, t = best
    print(f"blend: w={w:.2f} threshold={t:.2f} "
          f"val respond F1 {m['respond_f1']} archive F1 {m['archive_f1']}")

    # ---- gate: one shot --------------------------------------------------
    gate_ids = set(json.load(open(home / "data" / "gate_ids.json"))["ids"])
    rows = [json.loads(line) for line in open(labeled_path(),
                                              encoding="utf-8")]
    gate = sorted((r for r in rows if is_test(r) and r["id"] in gate_ids),
                  key=lambda r: r["d"])
    neural = json.load(open(neural_json))
    n_by_id = dict(zip(neural["ids"], neural["p_respond"]))
    p_c_gate, rest_gate = classical_gate_probs(classical_dir, bundle, gate)
    p_n_gate = np.asarray([n_by_id.get(r["id"], 0.0) for r in gate])

    p_ens_gate = w * p_c_gate + (1.0 - w) * p_n_gate
    y_pred = ["respond" if p >= t else rest_gate[i]
              for i, p in enumerate(p_ens_gate)]

    out = {
        "version": f"ensemble-v4-{classical_dir.name}-{neural_json.stem}",
        "ids": [r["id"] for r in gate],
        "y_pred": y_pred,
        "blend_w": w,
        "threshold": t,
        "classical": classical_dir.name,
        "neural": neural_json.stem,
    }
    with open(artifacts / "ensemble-eval-v4.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    report = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "blend_w": w,
        "threshold": t,
        "val_metrics": m,
        "classical": str(classical_dir.name),
        "neural": str(neural_json.stem),
        "note": "blend + threshold tuned on the frozen VAL carve; the gate "
                "is scored once",
    }
    with open(home / "mine" / "ensemble-v4-report.json", "w",
              encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"wrote {artifacts / 'ensemble-eval-v4.json'} "
          f"({len(y_pred)} gate predictions)")
    return 0


def classical_rest_pred(cdir: Path, bundle: dict, ids: list,
                        id_to_row: dict) -> list:
    """Classical head's argmax over the non-respond classes, per id order."""
    rows = [id_to_row[i] for i in ids]
    proba = bundle_probs(cdir, bundle, rows)
    classes = [str(c) for c in bundle["clf"].classes_]
    rest = [i for i, c in enumerate(classes) if c != "respond"]
    return [classes[int(np.argmax([row[i] for i in rest]))] for row in proba]


def classical_gate_probs(cdir: Path, bundle: dict, gate: list):
    proba = bundle_probs(cdir, bundle, gate)
    classes = [str(c) for c in bundle["clf"].classes_]
    rest = [i for i, c in enumerate(classes) if c != "respond"]
    p = np.asarray([row[classes.index("respond")] for row in proba])
    rest_pred = [classes[int(np.argmax([row[i] for i in rest]))]
                 for row in proba]
    return p, rest_pred


def bundle_probs(cdir: Path, bundle: dict, rows: list) -> np.ndarray:
    encoder = SentenceTransformer(str(cdir / "embedding-model"))
    X = encoder.encode(
        [compose_text(r["from"], r["subject"], r["snippet"]) for r in rows],
        batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    feats = [numeric_features(r, bundle["sender_priors"],
                              bundle["global_rate"], bundle["sender_seen"])
             for r in rows]
    X = np.hstack([X, np.asarray(feats, dtype=np.float32)])
    return bundle["clf"].predict_proba(X)


if __name__ == "__main__":
    raise SystemExit(main())
