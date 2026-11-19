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
  v4*         artifacts/model-v4*             v4 contest bundles
                                              (src/train_v4.py: upgraded
                                              embedder + GBDT head + tuned
                                              respond threshold); each is
                                              scored with its OWN bundle
                                              embedder, while v1/v1.5/v3
                                              keep the identical MiniLM
                                              snapshot bytes they shipped
                                              with
  neural-v4   artifacts/neural-eval-v4.json   threshold-tuned 1.5B-class
                                              LoRA (src/train_neural_v4.py)
  ensemble-v4 artifacts/ensemble-eval-v4.json stacked v4 probabilities
  neural      artifacts/neural-eval.json      the v3 Qwen2.5-0.5B candidate
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


_ENCODERS: dict = {}


def encoder_for(cdir: Path):
    """Bundle-local embedding snapshot. v4 bundles carry their own embedder
    (bge/Qwen3 class); the v1/v1.5/v3/v3.5 bundles all shipped the SAME
    MiniLM snapshot bytes, so their published bars reproduce exactly."""
    emb = cdir / "embedding-model"
    path = str(emb if emb.exists() else embedding_model_path())
    if path not in _ENCODERS:
        _ENCODERS[path] = SentenceTransformer(path)
    return _ENCODERS[path]


def evaluate_classical(bundle: dict, test: list, cdir: Path) -> dict:
    encoder = encoder_for(cdir)
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

    results = {}
    candidates = [
        ("v1", home() / "artifacts" / "model-v1-snapshot"),
        ("v1.5", home() / "artifacts" / "model-v1.5-snapshot"),
        ("v3", home() / "artifacts" / "model-v3"),
        ("v3.5", home() / "artifacts" / "model-v3p5"),
        ("deployed", home() / "artifacts" / "model"),
    ]
    # v4 contest bundles: every artifacts/model-v4* dir joins the table
    # (embedder/head variants frozen by src/train_v4.py before scoring).
    v4_names = []
    for cdir in sorted((home() / "artifacts").glob("model-v4*")):
        if (cdir / "model.joblib").exists():
            v4_names.append(cdir.name.replace("model-", ""))
            candidates.append((v4_names[-1], cdir))
    for name, cdir in candidates:
        path = cdir / "model.joblib"
        if not path.exists():
            continue
        bundle = joblib.load(path)
        results[name] = evaluate_classical(bundle, test, cdir)
        results[name]["version"] = bundle["version"]

    # json-prediction candidates: threshold-tuned neural + ensemble, written
    # by src/train_neural_v4.py (ids-aligned like the v3 neural row).
    for name, fname in (
        ("neural-v4", "neural-eval-v4.json"),
        ("ensemble-v4", "ensemble-eval-v4.json"),
    ):
        jpath = home() / "artifacts" / fname
        if not jpath.exists():
            continue
        pred = json.load(open(jpath))
        by_id = dict(zip(pred.get("ids", []), pred["y_pred"]))
        if by_id:
            y_pred = [by_id.get(r["id"], "archive") for r in test]
            results[name] = metrics([r["label"] for r in test], y_pred)
            results[name]["version"] = pred.get("version", name)

    order = ["v1", "v1.5", "v3", "v3.5", "deployed"] + v4_names + [
        "neural-v4", "ensemble-v4", "neural"]

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
    for name in order:
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
    for name in order:
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
