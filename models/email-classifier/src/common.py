"""Shared paths, labels, and feature text for the email action classifier."""

from __future__ import annotations

import os
from pathlib import Path

LABELS = ("respond", "archive", "mark-read")

# Standing eval split: everything dated on/after this boundary is held out.
# Fixed by design so eval numbers stay comparable as more mail is exported.
TEST_CUTOFF_MS = 1789435200000  # 2026-09-15T00:00:00Z

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def home() -> Path:
    """Durable artifact/data home. Defaults to this directory in the repo."""
    env = os.environ.get("EMAIL_CLASSIFIER_HOME")
    return Path(env) if env else Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    return home() / "data"


def labeled_path() -> Path:
    return data_dir() / "labeled.jsonl"


def is_train(row: dict) -> bool:
    """Standing split: everything older than TEST_CUTOFF trains — except
    mark-read rows, which train regardless of date.

    mark-read is only observable on the *current* inbox (read, not archived,
    no reply). Historical read-inbox items were eventually archived, so the
    class has no pre-cutoff history. The 15 current rows therefore join the
    train set by hand, are excluded from the held-out test (see is_test), and
    the eval report says so explicitly.
    """
    return row["d"] < TEST_CUTOFF_MS or row["label"] == "mark-read"


def is_test(row: dict) -> bool:
    return row["d"] >= TEST_CUTOFF_MS and row["label"] != "mark-read"


def artifacts_dir() -> Path:
    return home() / "artifacts"


def model_dir() -> Path:
    return artifacts_dir() / "model"


def embedding_model_path() -> Path:
    """Local sentence-transformers snapshot used for both train and serve."""
    return model_dir() / "embedding-model"


def compose_text(from_: str, subject: str, snippet: str) -> str:
    """Single text blob fed to the embedding model.

    Sender identity carries most of the routing signal (notifications vs
    humans), so it stays in the text instead of a separate feature block.
    """
    return f"From: {from_}\nSubject: {subject}\n{snippet}"
