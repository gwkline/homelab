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


def train_path() -> Path:
    """Training rows. Defaults to labeled.jsonl (the standing v1/v2 set);
    the v3 expansion points EMAIL_CLASSIFIER_TRAIN at
    data/labeled_v3_train.jsonl instead (src/build_train_v3.py builds it).
    The held-out test rows ALWAYS come from labeled.jsonl — the gate never
    follows this override, so a bigger train set can never quietly change
    the instrument."""
    env = os.environ.get("EMAIL_CLASSIFIER_TRAIN")
    return Path(env) if env else labeled_path()


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


# --- v1.5 engineered features -------------------------------------------
#
# Signals the embedding cannot express structurally: how often Gavin has
# replied to this sender before (leak-free: priors are computed from TRAIN
# rows only and frozen into the model bundle), whether the mail looks like
# bulk/newsletter traffic (List-Unsubscribe header on new exports, sender
# and snippet patterns everywhere), and whether this is a thread follow-up.

FEATURE_VERSION = "v1.5-emb+priors+bulk+reply"

BULK_SENDER_WORDS = (
    "no-reply", "noreply", "no_reply", "donotreply", "do-not-reply",
    "newsletter", "notifications", "notification", "news@", "announce",
    "marketing", "promos", "offers", "billing@", "receipts", "updates@",
    "mailer-daemon", "postmaster", "bounce", "via ", "on behalf of",
    "mailinglist", "mailing-list", "digest",
)


def sender_email(from_: str) -> str:
    """Best-effort bare address out of a From header."""
    if "<" in from_ and ">" in from_:
        return from_.rsplit("<", 1)[1].split(">", 1)[0].strip().lower()
    return from_.strip().lower()


def is_bulk(row: dict) -> int:
    """Bulk/newsletter traffic flag — never a reply target in practice."""
    if row.get("lu"):
        return 1
    hay = (row.get("from", "") + " " + row.get("snippet", "")).lower()
    if any(w in hay for w in BULK_SENDER_WORDS):
        return 1
    if "unsubscribe" in hay:
        return 1
    if row.get("pc", "") in ("bulk", "list", "auto", "junk", "autoreply"):
        return 1
    return 0


def is_reply_subject(subject: str) -> int:
    s = (subject or "").strip().lower()
    return 1 if s.startswith(("re:", "fw:", "fwd:")) else 0


def sender_priors(train_rows: list) -> tuple[dict, float, dict]:
    """Per-sender respond priors from TRAIN rows only.

    Smoothing keeps sparse senders near the global rate; the maps are
    frozen into the bundle so serving never recomputes them from data it
    should not see.
    """
    counts: dict[str, list[int]] = {}
    for r in train_rows:
        addr = sender_email(r.get("from", ""))
        n, resp = counts.get(addr, (0, 0)), int(r["label"] == "respond")
        counts[addr] = [n[0] + 1, n[1] + resp]
    total = sum(n for n, _ in counts.values())
    resp_total = sum(k for _, k in counts.values())
    global_rate = (resp_total + 1.0) / (total + 10.0)
    alpha = 5.0
    priors = {
        a: (k + alpha * global_rate) / (n + alpha)
        for a, (n, k) in counts.items()
    }
    seen = {a: n for a, (n, _k) in counts.items()}
    return priors, global_rate, seen


def numeric_features(row: dict, priors: dict, global_rate: float, seen: dict) -> list:
    """Engineered features appended to the embedding, all scaled to [0, 1]."""
    import math

    addr = sender_email(row.get("from", ""))
    prior = priors.get(addr, global_rate)
    n = seen.get(addr, 0)
    return [
        prior,
        min(1.0, math.log1p(n) / math.log1p(50.0)),
        float(is_bulk(row)),
        float(is_reply_subject(row.get("subject", ""))),
    ]
