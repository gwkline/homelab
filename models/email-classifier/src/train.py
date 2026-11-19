"""Train the email action classifier: MiniLM embeddings + logistic regression.

Trains on everything dated before the standing TEST_CUTOFF so the newest ~2
months stay held out for evals. Writes artifacts/model/{model.joblib,
metadata.json} and snapshots the embedding model beside them so serving never
touches the network.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import joblib
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression

from common import (
    EMBEDDING_MODEL,
    LABELS,
    TEST_CUTOFF_MS,
    compose_text,
    embedding_model_path,
    is_train,
    labeled_path,
    model_dir,
)


def main() -> int:
    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    train = [r for r in rows if is_train(r)]
    if not train:
        raise SystemExit("no training rows before TEST_CUTOFF")

    counts = {label: sum(1 for r in train if r["label"] == label) for label in LABELS}
    if min(counts.values()) == 0:
        raise SystemExit(f"empty class in train set: {counts}")
    print(f"train rows: {len(train)} (of {len(rows)} labeled)")
    for label in LABELS:
        print(f"  {label:9s} {counts[label]}")

    emb_path = embedding_model_path()
    if emb_path.exists():
        print(f"embedding model: local snapshot {emb_path}")
        encoder = SentenceTransformer(str(emb_path))
    else:
        print(f"embedding model: downloading {EMBEDDING_MODEL}")
        encoder = SentenceTransformer(EMBEDDING_MODEL)
    emb_path.parent.mkdir(parents=True, exist_ok=True)
    if not emb_path.exists():
        encoder.save(str(emb_path))

    texts = [compose_text(r["from"], r["subject"], r["snippet"]) for r in train]
    y = [r["label"] for r in train]
    t0 = time.time()
    X = encoder.encode(
        texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False
    )
    print(f"embedded {len(texts)} texts in {time.time() - t0:.1f}s")

    clf = LogisticRegression(class_weight="balanced", max_iter=2000, C=1.0)
    clf.fit(X, y)

    version = "v1-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    model_dir().mkdir(parents=True, exist_ok=True)
    bundle = {
        "version": version,
        "clf": clf,
        "classes": list(clf.classes_),
        "embedding_model": EMBEDDING_MODEL,
        "test_cutoff_ms": TEST_CUTOFF_MS,
        "train_counts": counts,
        "trained_at": datetime.now(timezone.utc).isoformat(),
    }
    joblib.dump(bundle, model_dir() / "model.joblib")
    with open(model_dir() / "metadata.json", "w", encoding="utf-8") as fh:
        json.dump(
            {
                "version": version,
                "embedding_model": EMBEDDING_MODEL,
                "classifier": "sklearn.linear_model.LogisticRegression",
                "classifier_params": {
                    "class_weight": "balanced",
                    "max_iter": 2000,
                    "C": 1.0,
                },
                "test_cutoff_ms": TEST_CUTOFF_MS,
                "train_counts": counts,
                "trained_at": bundle["trained_at"],
            },
            fh,
            indent=2,
        )
    print(f"saved {model_dir() / 'model.joblib'} ({version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
