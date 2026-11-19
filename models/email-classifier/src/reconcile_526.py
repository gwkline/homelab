"""#526 reconciliation: score models on the parked post-cutoff batch.

The 2,944 post-cutoff non-gate rows (all archive; frozen in
mine/postcutoff_holdout_ids.json by src/build_train_v3.py) are the live
drift-reconciliation batch for homelab issue #526 — models never train on
them. This script scores a candidate over that batch and reports
AGGREGATE counts only (no message content): how often a model would
suggest `respond` on real 2026 archive traffic — the false-suggestion
rate the briefing cron would actually surface.

Modes via argv[1]:
  bundle <dir>   classical bundle (run with EMAIL_CLASSIFIER_HOME's .venv)
  neural <dir>   fused LoRA model dir (run with the .venv-mlx python);
                 threshold read from artifacts/neural-eval-v4.json

Writes mine/reconcile_526.json (appends per-model entries) and prints
the summary.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from common import TEST_CUTOFF_MS, compose_text, data_dir, home, is_test

LABELS = ["respond", "archive", "mark-read"]
PROMPT = (
    "Predict the one action Gavin takes on this email: respond, archive, or "
    "mark-read. Answer with exactly one word, nothing else.\n\n"
    "From: {f}\nSubject: {s}\nBody: {n}"
)


def batch_rows() -> list:
    ids = set(json.load(open(home() / "mine" / "postcutoff_holdout_ids.json"))["ids"])
    rows = [json.loads(line)
            for line in open(data_dir() / "labeled_v3.jsonl", encoding="utf-8")]
    return sorted((r for r in rows if r["id"] in ids), key=lambda r: r["d"])


def summarize(name: str, y_pred: list, seconds: float, extra: dict) -> int:
    from collections import Counter

    counts = Counter(y_pred)
    out = {
        "model": name,
        "rows": len(y_pred),
        "predicted": dict(counts),
        "respond_suggestions": counts.get("respond", 0),
        "respond_share": round(counts.get("respond", 0) / max(len(y_pred), 1), 4),
        "seconds": round(seconds, 1),
        "true_labels": "all archive (parked #526 batch)",
        **extra,
    }
    path = home() / "mine" / "reconcile_526.json"
    log = json.load(open(path)) if path.exists() else []
    log = [e for e in log if e.get("model") != name] + [out]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(log, fh, indent=2)
    print(json.dumps(out, indent=2))
    return 0


def bundle_mode(cdir: Path) -> int:
    import joblib
    import numpy as np
    from sentence_transformers import SentenceTransformer

    from common import numeric_features

    bundle = joblib.load(cdir / "model.joblib")
    rows = batch_rows()
    encoder = SentenceTransformer(str(cdir / "embedding-model"))
    t0 = time.time()
    X = encoder.encode(
        [compose_text(r["from"], r["subject"], r["snippet"]) for r in rows],
        batch_size=64, normalize_embeddings=True, show_progress_bar=False)
    feats = [numeric_features(r, bundle["sender_priors"],
                              bundle["global_rate"], bundle["sender_seen"])
             for r in rows]
    X = np.hstack([X, np.asarray(feats, dtype=np.float32)])
    proba = bundle["clf"].predict_proba(X)
    classes = [str(c) for c in bundle["clf"].classes_]
    ri = classes.index("respond")
    rest = [i for i, c in enumerate(classes) if c != "respond"]
    threshold = bundle.get("respond_threshold")
    if threshold is not None:
        y_pred = ["respond" if row[ri] >= float(threshold)
                  else classes[int(np.argmax([row[i] for i in rest]))]
                  for row in proba]
    else:
        y_pred = [classes[int(np.argmax(row))] for row in proba]
    return summarize(f"bundle:{cdir.name}", y_pred, time.time() - t0,
                     {"version": bundle.get("version"),
                      "threshold": threshold})


def neural_mode(mdir: Path) -> int:
    import math

    import mlx.core as mx
    from mlx_lm import load
    from transformers import AutoTokenizer

    import numpy as np

    threshold = json.load(
        open(home() / "artifacts" / "neural-eval-v4.json"))["threshold"]
    model, _tok = load(str(mdir))
    tok = AutoTokenizer.from_pretrained(str(mdir))
    rows = batch_rows()
    t0 = time.time()
    y_pred = []
    for row in rows:
        messages = [{"role": "user",
                     "content": PROMPT.format(f=row["from"], s=row["subject"],
                                              n=row["snippet"])}]
        text = tok.apply_chat_template(messages, add_generation_prompt=True,
                                       tokenize=False)
        ids_prompt = tok.encode(text, add_special_tokens=False)
        scores = {}
        for label in LABELS:
            ids_label = tok.encode(label, add_special_tokens=False)
            ids = mx.array([ids_prompt + ids_label])
            logits = model(ids)
            arr = np.asarray(logits[0].astype(mx.float32))
            peak = arr.max(axis=-1, keepdims=True)
            logprobs = arr - peak - np.log(
                np.exp(arr - peak).sum(axis=-1, keepdims=True))
            total = 0.0
            for k, t in enumerate(ids_label):
                total += float(logprobs[len(ids_prompt) + k - 1, t])
            scores[label] = total
        m = max(scores.values())
        exps = {k: math.exp(v - m) for k, v in scores.items()}
        z = sum(exps.values())
        p_resp = exps["respond"] / z
        if p_resp >= threshold:
            y_pred.append("respond")
        else:
            rest = max((k for k in LABELS if k != "respond"),
                       key=lambda k: scores[k])
            y_pred.append(rest)
        if len(y_pred) % 500 == 0:
            print(f"scored {len(y_pred)}/{len(rows)} "
                  f"({time.time() - t0:.0f}s)", flush=True)
    return summarize(f"neural:{mdir.name}", y_pred, time.time() - t0,
                     {"threshold": threshold})


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "bundle":
        raise SystemExit(bundle_mode(Path(sys.argv[2])))
    if mode == "neural":
        raise SystemExit(neural_mode(Path(sys.argv[2])))
    raise SystemExit(__doc__)
