"""FastAPI inference service for the email action classifier.

Deployment-owned copy — this file is what the cluster serves; the training
pipeline lives at models/email-classifier/. compose_text below mirrors
models/email-classifier/src/common.py: keep them identical.

Loads the model bundle and embedding-model snapshot once at startup from
EMAIL_CLASSIFIER_HOME (default /state/ec-home). No network at runtime.
"""

from __future__ import annotations

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


def compose_text(from_: str, subject: str, snippet: str) -> str:
    """Single text blob fed to the embedding model (mirrors src/common.py).

    Sender identity carries most of the routing signal, so it stays in the
    text instead of a separate feature block.
    """
    return f"From: {from_}\nSubject: {subject}\n{snippet}"


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


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_state()
    yield


app = FastAPI(title="email-classifier", version="1", lifespan=lifespan)


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
