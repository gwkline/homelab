"""Scorecard: compare classifier candidates on the fixed held-out split.

Evaluates every available bundle on the SAME test rows (the standing split in
src/common.py) and writes evals/scorecard.md with aggregate metrics only —
no message content, no personal data.

Bundles evaluated (whatever exists on disk):
  v1      artifacts/model-v1-snapshot   embeddings-only, v1 data (1,381 rows)
  v1.5    artifacts/model               embeddings + engineered features,
                                        expanded data (2,945 rows)
  neural  artifacts/neural-eval.json    written by src/train_neural.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics import classification_report, confusion_matrix

from common import (
    LABELS,
    TEST_CUTOFF_MS,
    compose_text,
    embedding_model_path,
    is_test,
    labeled_path,
    numeric_features,
)
from common import home


def fmt_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def evaluate_classical(bundle: dict, test: list, encoder) -> dict:
    X = encoder.encode(
        [compose_text(r["from"], r["subject"], r["snippet"]) for r in test],
        batch_size=64,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    if bundle.get("feature_version"):
        feats = [
            numeric_features(
                r, bundle["sender_priors"], bundle["global_rate"], bundle["sender_seen"]
            )
            for r in test
        ]
        X = np.hstack([X, np.asarray(feats, dtype=np.float32)])
    y_pred = bundle["clf"].predict(X)
    y_true = [r["label"] for r in test]
    return metrics(y_true, y_pred)


def metrics(y_true, y_pred) -> dict:
    report = classification_report(
        y_true, y_pred, labels=LABELS, digits=3, zero_division=0, output_dict=True
    )
    cm = confusion_matrix(y_true, y_pred, labels=LABELS)
    out = {"accuracy": float((np.asarray(y_pred) == np.asarray(y_true)).mean())}
    for label in LABELS:
        if label in report and report[label]["support"]:
            out[label] = {
                "precision": report[label]["precision"],
                "recall": report[label]["recall"],
                "f1": report[label]["f1-score"],
                "support": int(report[label]["support"]),
            }
    out["cm"] = cm.tolist()
    return out


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    test = sorted([r for r in rows if is_test(r)], key=lambda r: r["d"])
    encoder = SentenceTransformer(str(embedding_model_path()))

    results = {}

    v1_path = home() / "artifacts" / "model-v1-snapshot" / "model.joblib"
    if v1_path.exists():
        results["v1"] = evaluate_classical(joblib.load(v1_path), test, encoder)
        results["v1"]["version"] = joblib.load(v1_path)["version"]

    v15_path = home() / "artifacts" / "model" / "model.joblib"
    if v15_path.exists():
        bundle = joblib.load(v15_path)
        results["v1.5"] = evaluate_classical(bundle, test, encoder)
        results["v1.5"]["version"] = bundle["version"]

    neural_path = home() / "artifacts" / "neural-eval.json"
    if neural_path.exists():
        neural = json.load(open(neural_path))
        results["neural"] = metrics(
            [r["label"] for r in test], neural["y_pred"]
        )
        results["neural"]["version"] = neural.get("version", "neural")

    n_respond = sum(1 for r in test if r["label"] == "respond")
    lines = []
    a = lines.append
    a("# Email action classifier — candidate scorecard")
    a("")
    a(f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} by "
      "`evals/run.sh` on the fixed held-out split (cutoff "
      f"{fmt_date(TEST_CUTOFF_MS)}). Aggregate metrics only._")
    a("")
    a(f"**Test rows:** {len(test)} ({n_respond} respond, "
      f"{len(test) - n_respond} archive; mark-read is train-only by design).")
    a("")
    a("| candidate | respond P | respond R | respond F1 | archive F1 | accuracy |")
    a("| --- | ---: | ---: | ---: | ---: | ---: |")
    for name in ("v1", "v1.5", "neural"):
        if name not in results:
            continue
        m = results[name]
        resp = m.get("respond", {})
        arch = m.get("archive", {})
        a(
            f"| {name} (`{m['version']}`) "
            f"| {resp.get('precision', 0):.3f} | {resp.get('recall', 0):.3f} "
            f"| {resp.get('f1', 0):.3f} | {arch.get('f1', 0):.3f} "
            f"| {m['accuracy']:.3f} |"
        )
    a("")
    a("respond F1 is the primary target; archive F1 is the guardrail. A")
    a("candidate deploys only if it beats the classical baseline on the")
    a("same split (eval numbers decide).")
    a("")
    for name in ("v1", "v1.5", "neural"):
        if name not in results:
            continue
        m = results[name]
        cm = m["cm"]
        a(f"## Confusion — {name}")
        a("")
        a("| true \\\\ pred | " + " | ".join(LABELS) + " |")
        a("| --- | " + " | ".join("---" for _ in LABELS) + " |")
        for i, label in enumerate(LABELS):
            support = int(sum(cm[i]))
            cells = []
            for j in range(len(LABELS)):
                cells.append("—" if support == 0 else f"{cm[i][j]}")
            a(f"| **{label}** | " + " | ".join(cells) + " |")
        a("")

    for path in (repo / "evals" / "scorecard.md", home() / "eval" / "scorecard.md"):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    print(f"wrote {repo / 'evals' / 'scorecard.md'}")
    for name, m in results.items():
        resp = m.get("respond", {})
        arch = m.get("archive", {})
        print(
            f"{name:8s} respond P/R/F1 "
            f"{resp.get('precision', 0):.3f}/{resp.get('recall', 0):.3f}"
            f"/{resp.get('f1', 0):.3f}  archive F1 {arch.get('f1', 0):.3f}  "
            f"acc {m['accuracy']:.3f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
