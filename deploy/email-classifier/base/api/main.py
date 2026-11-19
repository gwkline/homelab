"""FastAPI inference service for the email action classifier.

Deployment-owned copy — this file is what the cluster serves; the training
pipeline lives at models/email-classifier/. The feature helpers below mirror
models/email-classifier/src/common.py: keep them identical.

Loads the model bundle and embedding-model snapshot once at startup from
EMAIL_CLASSIFIER_HOME (default /state/ec-home). No network at runtime.

Serves both bundle generations:
  v1     embeddings only (384-d);
  v1.5+  bundle carries `feature_version` + frozen sender priors — the four
         engineered features are appended to the embedding before predict.
"""

from __future__ import annotations

import math
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import joblib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sentence_transformers import SentenceTransformer

HOME = Path(os.environ.get("EMAIL_CLASSIFIER_HOME", "/state/ec-home"))
MODEL_DIR = HOME / "artifacts" / "model"

BULK_SENDER_WORDS = (
    "no-reply", "noreply", "no_reply", "donotreply", "do-not-reply",
    "newsletter", "notifications", "notification", "news@", "announce",
    "marketing", "promos", "offers", "billing@", "receipts", "updates@",
    "mailer-daemon", "postmaster", "bounce", "via ", "on behalf of",
    "mailinglist", "mailing-list", "digest",
)


def compose_text(from_: str, subject: str, snippet: str) -> str:
    """Single text blob fed to the embedding model (mirrors src/common.py).

    Sender identity carries most of the routing signal, so it stays in the
    text instead of a separate feature block.
    """
    return f"From: {from_}\nSubject: {subject}\n{snippet}"


def sender_email(from_: str) -> str:
    if "<" in from_ and ">" in from_:
        return from_.rsplit("<", 1)[1].split(">", 1)[0].strip().lower()
    return from_.strip().lower()


def is_bulk(from_: str, snippet: str, pc: str = "", lu: int = 0) -> float:
    if lu:
        return 1.0
    hay = f"{from_} {snippet}".lower()
    if any(w in hay for w in BULK_SENDER_WORDS):
        return 1.0
    if "unsubscribe" in hay:
        return 1.0
    if pc in ("bulk", "list", "auto", "junk", "autoreply"):
        return 1.0
    return 0.0


def is_reply_subject(subject: str) -> float:
    s = (subject or "").strip().lower()
    return 1.0 if s.startswith(("re:", "fw:", "fwd:")) else 0.0


def numeric_features(
    from_: str, subject: str, snippet: str, priors: dict, global_rate: float, seen: dict
) -> list:
    addr = sender_email(from_)
    return [
        priors.get(addr, global_rate),
        min(1.0, math.log1p(seen.get(addr, 0)) / math.log1p(50.0)),
        is_bulk(from_, snippet),
        is_reply_subject(subject),
    ]


class EmailIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    subject: str = ""
    snippet: str = ""


class Prediction(BaseModel):
    label: str
    probabilities: dict[str, float]
    model_version: str
    latency_ms: float


STATE: dict[str, object] = {}


def load_state() -> None:
    bundle = joblib.load(MODEL_DIR / "model.joblib")
    STATE["clf"] = bundle["clf"]
    STATE["version"] = bundle["version"]
    STATE["encoder"] = SentenceTransformer(str(MODEL_DIR / "embedding-model"))
    if bundle.get("feature_version"):
        STATE["priors"] = bundle["sender_priors"]
        STATE["seen"] = bundle["sender_seen"]
        STATE["global_rate"] = bundle["global_rate"]
        STATE["feature_version"] = bundle["feature_version"]


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_state()
    yield


app = FastAPI(title="email-classifier", version="2", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> dict[str, bool]:
    return {"ok": "clf" in STATE}


@app.post("/predict", response_model=Prediction)
def predict(email: EmailIn) -> Prediction:
    if "clf" not in STATE:
        raise HTTPException(status_code=503, detail="model not loaded")
    started = time.perf_counter()
    text = compose_text(email.from_, email.subject, email.snippet)
    emb = STATE["encoder"].encode(  # type: ignore[attr-defined]
        [text], normalize_embeddings=True, show_progress_bar=False
    )
    if "feature_version" in STATE:
        import numpy as np

        feats = [
            numeric_features(
                email.from_,
                email.subject,
                email.snippet,
                STATE["priors"],  # type: ignore[operator]
                STATE["global_rate"],  # type: ignore[operator]
                STATE["seen"],  # type: ignore[operator]
            )
        ]
        emb = np.hstack([emb, np.asarray(feats, dtype=np.float32)])
    clf = STATE["clf"]  # type: ignore[operator]
    proba = clf.predict_proba(emb)[0]
    classes = [str(c) for c in clf.classes_]
    best = max(zip(classes, proba), key=lambda pair: pair[1])[0]
    return Prediction(
        label=best,
        probabilities={c: round(float(p), 4) for c, p in zip(classes, proba)},
        model_version=str(STATE["version"]),
        latency_ms=round((time.perf_counter() - started) * 1000, 1),
    )
