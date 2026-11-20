"""Frozen-gate contest scorecard for the v5 distillation (#543).

Same instrument as evals/scorecard.md — the frozen 373-row
data/gate_ids.json gate, gate rows resolved from data/labeled.jsonl —
with the v5 addition that bundles carrying a tuned `respond_threshold`
are scored by the SERVING rule (respond iff raw p_respond >= threshold,
else the best non-respond class; exactly deploy/email-classifier/base/
api/main.py's rule), not plain argmax. Bundles without a threshold keep
argmax. The rule each row was scored with is printed in the table.

Two verification rows gate the whole table:
  v1.5 incumbent  must reproduce the published bars 0.400/0.778/0.528;
  teacher         the batch-scored neural-v4's own gate row must
                  reproduce its published 0.429/0.833/0.566 — asserting
                  both the teacher batch inference and the thresholded
                  rule in one shot.

Candidates (whatever exists on disk; DISTILL_SOFT_DIR / DISTILL_HARD_DIR
override the two student bundle paths, DISTILL_SOFT_NAME /
DISTILL_HARD_NAME their table labels, DISTILL_SCORECARD_TITLE the report
heading — the v6 retry (#545) points these at the v6d students without
touching the gate rows, rules, or verification bars):
  v1.5 (incumbent)   artifacts/model-v1.5-snapshot
  v3-full (new-data baseline)  artifacts/model-v3full
  v5d-soft / v5d-hard  the distilled students (default labels)
  teacher (reference)  artifacts/teacher-scores-v4.jsonl @ threshold.json

Outputs: $HOME/eval/distill-scorecard.md + $HOME/mine/distill_scorecard.json
(aggregate metrics only — no message content, no ids).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent)
sys.path.insert(0, REPO_SRC)

from common import (  # noqa: E402
    LABELS,
    compose_text,
    data_dir,
    embedding_model_path,
    is_test,
    labeled_path,
)
import scorecard as SC  # noqa: E402
import numpy as np  # noqa: E402
from sentence_transformers import SentenceTransformer  # noqa: E402

from common import home  # noqa: E402

os.environ.setdefault("EMAIL_CLASSIFIER_HOME", str(home()))

PUBLISHED_V15 = {"precision": 0.400, "recall": 0.778, "f1": 0.528}
PUBLISHED_V15_ARCHIVE_F1 = 0.931
PUBLISHED_TEACHER = {"precision": 0.429, "recall": 0.833, "f1": 0.566}


def predict_bundle(bundle: dict, test: list, encoder) -> tuple[list, dict]:
    """Serving-faithful predictions: threshold rule when the bundle
    carries one, plain argmax otherwise."""
    X = encoder.encode(
        [compose_text(r["from"], r["subject"], r["snippet"]) for r in test],
        batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    if bundle.get("feature_version"):
        feats = [SC.numeric_features(
            r, bundle["sender_priors"], bundle["global_rate"],
            bundle["sender_seen"]) for r in test]
        X = np.hstack([X, np.asarray(feats, dtype=np.float32)])
    proba = bundle["clf"].predict_proba(X)
    classes = [str(c) for c in bundle["clf"].classes_]
    ri = classes.index("respond")
    threshold = bundle.get("respond_threshold")
    if threshold is None:
        y_pred = [classes[int(np.argmax(row))] for row in proba]
    else:
        rest_idx = [i for i, c in enumerate(classes) if c != "respond"]
        y_pred = []
        for row in proba:
            if row[ri] >= threshold:
                y_pred.append("respond")
            else:
                y_pred.append(classes[int(np.argmax([row[i]
                                                      for i in rest_idx]))])
    return y_pred, {"rule": "threshold" if threshold is not None
                    else "argmax", "proba": proba, "classes": classes,
                    "respond_idx": ri}


def reliability_bins(y_true: list, p_resp: np.ndarray) -> list:
    z = (np.asarray(y_true) == "respond").astype(float)
    bins = []
    for lo in np.linspace(0.0, 0.9, 10):
        mask = (p_resp >= lo) & (p_resp < lo + 0.1)
        if mask.sum():
            bins.append({"bin": f"{lo:.1f}-{lo + 0.1:.1f}",
                         "n": int(mask.sum()),
                         "mean_pred": round(float(p_resp[mask].mean()), 4),
                         "observed": round(float(z[mask].mean()), 4)})
    return bins


def ece(y_true: list, p_resp: np.ndarray) -> float:
    z = (np.asarray(y_true) == "respond").astype(float)
    total, acc = len(y_true), 0.0
    for lo in np.linspace(0.0, 0.9, 10):
        mask = (p_resp >= lo) & (p_resp < lo + 0.1)
        if mask.sum():
            acc += mask.sum() / total * abs(
                float(z[mask].mean()) - float(p_resp[mask].mean()))
    return round(acc, 4)


def main() -> int:
    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    gate = set(json.load(open(data_dir() / "gate_ids.json"))["ids"])
    test = sorted([r for r in rows if is_test(r) and r["id"] in gate],
                  key=lambda r: r["d"])
    n_respond = sum(1 for r in test if r["label"] == "respond")
    print(f"gate rows: {len(test)} ({n_respond} respond)")
    if len(test) != 373:
        raise SystemExit(f"instrument drift: gate resolved to {len(test)} rows")
    y_true = [r["label"] for r in test]
    encoder = SentenceTransformer(str(embedding_model_path()))

    soft_dir = Path(os.environ.get(
        "DISTILL_SOFT_DIR", home() / "artifacts" / "model-v5d-soft"))
    hard_dir = Path(os.environ.get(
        "DISTILL_HARD_DIR", home() / "artifacts" / "model-v5d-hard"))
    soft_name = os.environ.get("DISTILL_SOFT_NAME", "v5d-soft (distill)")
    hard_name = os.environ.get("DISTILL_HARD_NAME", "v5d-hard (distill)")
    candidates = [
        ("v1.5 (incumbent)", home() / "artifacts" / "model-v1.5-snapshot"),
        ("v3-full (new-data baseline)", home() / "artifacts" / "model-v3full"),
        (soft_name, soft_dir),
        (hard_name, hard_dir),
    ]

    import joblib

    results = {}
    calib = {}
    for name, path in candidates:
        bpath = path / "model.joblib"
        if not bpath.exists():
            print(f"skip {name}: no bundle at {bpath}")
            continue
        bundle = joblib.load(bpath)
        y_pred, info = predict_bundle(bundle, test, encoder)
        m = SC.metrics(y_true, y_pred)
        m["version"] = bundle["version"]
        m["rule"] = info["rule"]
        ri = info["respond_idx"]
        calib[name] = {
            "bins": reliability_bins(y_true, info["proba"][:, ri]),
            "ece": ece(y_true, info["proba"][:, ri]),
        }
        results[name] = m
        resp = m.get("respond", {})
        arch = m.get("archive", {})
        print(f"{name:30s} {m['version']:28s} {m['rule']:9s} respond "
              f"{resp.get('precision', 0):.3f}/{resp.get('recall', 0):.3f}"
              f"/{resp.get('f1', 0):.3f}  archive F1 "
              f"{arch.get('f1', 0):.3f}  acc {m['accuracy']:.3f}")

    # --- teacher reference row: its own gate scores from the batch pass ---
    teacher_path = home() / "artifacts" / "teacher-scores-v4.jsonl"
    if teacher_path.exists():
        gate_scores = {}
        with open(teacher_path, encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                if r["split"] == "gate":
                    gate_scores[r["id"]] = r
        t_meta = json.load(open(home() / "artifacts" / "neural-fused-v4"
                                / "threshold.json", encoding="utf-8"))
        t = float(t_meta["respond_threshold"])
        if len(gate_scores) == len(test):
            y_teacher = [
                "respond" if gate_scores[r["id"]]["p_respond"] >= t
                else gate_scores[r["id"]]["rest"] for r in test]
            m = SC.metrics(y_true, y_teacher)
            m["version"] = t_meta.get("version", "teacher")
            m["rule"] = "threshold"
            results["teacher (reference)"] = m
            p_resp = np.asarray([gate_scores[r["id"]]["p_respond"]
                                 for r in test])
            calib["teacher (reference)"] = {
                "bins": reliability_bins(y_true, p_resp), "ece": ece(y_true, p_resp)}
            resp = m.get("respond", {})
            arch = m.get("archive", {})
            print(f"{'teacher (reference)':30s} {m['version']:28s} "
                  f"{m['rule']:9s} respond "
                  f"{resp.get('precision', 0):.3f}/{resp.get('recall', 0):.3f}"
                  f"/{resp.get('f1', 0):.3f}  archive F1 "
                  f"{arch.get('f1', 0):.3f}  acc {m['accuracy']:.3f}")

    # --- instrument verification -----------------------------------------
    drift = []
    v15 = results.get("v1.5 (incumbent)", {}).get("respond", {})
    for key, pub in PUBLISHED_V15.items():
        got = round(v15.get(key, 0), 3)
        if abs(got - pub) > 0.001:
            drift.append(f"v1.5 {key}: got {got}, published {pub}")
    teacher_m = results.get("teacher (reference)", {}).get("respond", {})
    for key, pub in PUBLISHED_TEACHER.items():
        got = round(teacher_m.get(key, 0), 3)
        if abs(got - pub) > 0.001:
            drift.append(f"teacher {key}: got {got}, published {pub}")
    verified = not drift
    print("instrument verified vs published v1.5 + teacher bars"
          if verified else f"INSTRUMENT DRIFT: {drift}")

    # --- ship verdict per candidate (the card's promotion rule) ---------
    verdicts = {}
    for name, m in results.items():
        if name.startswith(("v1.5", "teacher")):
            continue
        resp_f1 = m.get("respond", {}).get("f1", 0)
        arch_f1 = m.get("archive", {}).get("f1", 0)
        strict = (resp_f1 > PUBLISHED_V15["f1"]
                  and arch_f1 >= PUBLISHED_V15_ARCHIVE_F1)
        approaches_teacher = resp_f1 >= 0.55
        verdicts[name] = {
            "respond_f1": resp_f1, "archive_f1": arch_f1,
            "beats_incumbent_strict": bool(strict),
            "approaches_teacher": bool(approaches_teacher),
        }
        print(f"verdict {name}: {'SHIP (strict win)' if strict else 'no ship'}"
              f"{'; >=0.55 (teacher-class)' if approaches_teacher else ''}")

    # --- report -----------------------------------------------------------
    lines = []
    a = lines.append
    title = os.environ.get("DISTILL_SCORECARD_TITLE",
                           "v5 distillation scorecard (#543)")
    a(f"# Email action classifier — {title}")
    a("")
    a(f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
      " on the FROZEN 373-row gate (data/gate_ids.json, v2 labels), "
      "identical instrument to evals/scorecard.md. Bundles with a tuned "
      "respond threshold are scored by the serving rule (threshold column); "
      "the incumbent keeps argmax. Aggregate metrics only._")
    a("")
    a(f"Instrument verification: incumbent v1.5 re-run reproduces published "
      f"bars and the batch-scored teacher reproduces its published gate row "
      f"({'PASS' if verified else 'FAIL: ' + '; '.join(drift)}).")
    a("")
    a("| candidate | version | rule | respond P | respond R | respond F1 | "
      "archive F1 | accuracy |")
    a("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |")
    for name, _path in candidates:
        if name not in results:
            continue
        m = results[name]
        resp = m.get("respond", {})
        arch = m.get("archive", {})
        a(f"| {name} | `{m['version']}` | {m['rule']} | "
          f"{resp.get('precision', 0):.3f} | {resp.get('recall', 0):.3f} | "
          f"{resp.get('f1', 0):.3f} | {arch.get('f1', 0):.3f} | "
          f"{m['accuracy']:.3f} |")
    if "teacher (reference)" in results:
        m = results["teacher (reference)"]
        resp = m.get("respond", {})
        arch = m.get("archive", {})
        a(f"| teacher (reference) | `{m['version']}` | {m['rule']} | "
          f"{resp.get('precision', 0):.3f} | {resp.get('recall', 0):.3f} | "
          f"{resp.get('f1', 0):.3f} | {arch.get('f1', 0):.3f} | "
          f"{m['accuracy']:.3f} |")
    a("")
    a("respond F1 is the primary target; archive F1 is the guardrail "
      "(incumbent 0.931). A distilled student ships as the classical "
      "FALLBACK only on a strict win: respond F1 > 0.528 with archive "
      "F1 >= 0.931; the neural stays the primary serving path either way.")
    a("")
    for name, _path in candidates:
        if name not in results:
            continue
        m = results[name]
        cm = m["cm"]
        a(f"## Confusion — {name}")
        a("")
        a("| true \\ pred | " + " | ".join(LABELS) + " |")
        a("| --- | " + " | ".join("---" for _ in LABELS) + " |")
        for i, label in enumerate(LABELS):
            support = int(sum(cm[i]))
            cells = ["—" if support == 0 else f"{cm[i][j]}"
                     for j in range(len(LABELS))]
            a(f"| **{label}** | " + " | ".join(cells) + " |")
        a("")
    a("## Gate calibration (reliability bins, aggregate counts only)")
    a("")
    for name, c in calib.items():
        a(f"**{name}** — ECE {c['ece']:.4f}")
        a("")
        a("| p(respond) bin | n | mean pred | observed |")
        a("| --- | ---: | ---: | ---: |")
        for b in c["bins"]:
            a(f"| {b['bin']} | {b['n']} | {b['mean_pred']:.4f} | "
              f"{b['observed']:.4f} |")
        a("")

    report = home() / "eval" / "distill-scorecard.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    with open(report, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    with open(home() / "mine" / "distill_scorecard.json", "w",
              encoding="utf-8") as fh:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(),
                   "gate_rows": len(test),
                   "instrument_verified_vs_published": verified,
                   "results": {k: {kk: vv for kk, vv in v.items()
                                   if kk != "cm"}
                               for k, v in results.items()},
                   "confusion": {k: v["cm"] for k, v in results.items()},
                   "calibration": calib,
                   "verdicts": verdicts}, fh, indent=2)
    print(f"wrote {report}")
    return 0 if verified else 3


if __name__ == "__main__":
    raise SystemExit(main())
