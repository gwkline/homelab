"""Scorecard: compare classifier candidates on the fixed held-out split.

Evaluates every available bundle on the SAME test rows (the standing split
in src/common.py, frozen id-for-id in data/gate_ids.json so the v3 history
expansion can never quietly change the instrument) and writes
evals/scorecard.md with aggregate metrics only — no message content, no
personal data.

Bundles evaluated (whatever exists on disk, in table order):
  v1          artifacts/model-v1-snapshot     v1 data (1,381 rows)
  v1.5        artifacts/model-v1.5-snapshot  incumbent, frozen when a new
                                              candidate promotes
  v3          artifacts/model-v3              full-history candidate
                                              (src/build_train_v3.py data)
  deployed    artifacts/model                 the bundle serving in the
                                              cluster (symlink target)
  neural      artifacts/neural-eval.json      written by src/train_neural.py
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
    data_dir,
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
    # Frozen gate: the scorecard scores exactly the ids in data/gate_ids.json
    # (v2-labeled). The v3 re-derivation may re-label some of them; those
    # disagreements are reported by src/build_train_v3.py and reconciled in
    # homelab issue #526 — the gate itself never changes mid-contest.
    gate = set(json.load(open(data_dir() / "gate_ids.json"))["ids"]) \
        if (data_dir() / "gate_ids.json").exists() else None
    test = sorted([r for r in rows if is_test(r)
                   and (gate is None or r["id"] in gate)],
                  key=lambda r: r["d"])
    encoder = SentenceTransformer(str(embedding_model_path()))

    results = {}
    candidates = [
        ("v1", home() / "artifacts" / "model-v1-snapshot"),
        ("v1.5", home() / "artifacts" / "model-v1.5-snapshot"),
        ("v3", home() / "artifacts" / "model-v3"),
        ("v3.5", home() / "artifacts" / "model-v3p5"),
        ("deployed", home() / "artifacts" / "model"),
    ]
    for name, cdir in candidates:
        path = cdir / "model.joblib"
        if not path.exists():
            continue
        bundle = joblib.load(path)
        results[name] = evaluate_classical(bundle, test, encoder)
        results[name]["version"] = bundle["version"]

    neural_path = home() / "artifacts" / "neural-eval.json"
    if neural_path.exists():
        neural = json.load(open(neural_path))
        neural_ids = set(neural.get("ids", []))
        if neural_ids and neural_ids != {r["id"] for r in test}:
            # neural predictions were scored on a different gate snapshot;
            # re-align by id so the frozen gate keeps columns comparable.
            by_id = dict(zip(neural["ids"], neural["y_pred"]))
            y_pred = [by_id.get(r["id"], "archive") for r in test]
        else:
            y_pred = neural["y_pred"]
        results["neural"] = metrics([r["label"] for r in test], y_pred)
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
    for name in ("v1", "v1.5", "v3", "v3.5", "deployed", "neural"):
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
    for name in ("v1", "v1.5", "v3", "v3.5", "deployed", "neural"):
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
