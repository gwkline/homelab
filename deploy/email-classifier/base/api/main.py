"""FastAPI inference service for the email action classifier.

Deployment-owned copy — this file is what the cluster serves; the training
pipeline lives at models/email-classifier/. The feature helpers below mirror
models/email-classifier/src/common.py: keep them identical.

Loads the model bundle and embedding-model snapshot once at startup from
EMAIL_CLASSIFIER_HOME (default /state/ec-home). No network at runtime.

Serves every bundle generation:
  v1     embeddings only (384-d);
  v1.5+  bundle carries `feature_version` + frozen sender priors — the four
         engineered features are appended to the embedding before predict;
  v4+    bundles may carry `respond_threshold` — respond iff the raw
         respond probability clears it (mirrors src/train_v4.py);
  neural when NEURAL_MODEL_DIR exists on its own PVC, the fused v4 LoRA LM
         serves instead (label-logprob scoring mirrors
         src/train_neural_v4.py; threshold.json rides with the model).
         Any load failure — or a renamed-away dir — falls back to the
         classical bundle, so rollback needs no code change.
"""

from __future__ import annotations

import json
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

# Optional neural mode (v4+): a fused LoRA LM on its own PVC volume.
# Present -> it serves; absent or broken -> the classical bundle serves.
NEURAL_DIR = Path(os.environ.get("NEURAL_MODEL_DIR", ""))
NEURAL_PROMPT = (
    "Predict the one action Gavin takes on this email: respond, archive, or "
    "mark-read. Answer with exactly one word, nothing else.\n\n"
    "From: {f}\nSubject: {s}\nBody: {n}"
)

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


def load_neural() -> dict | None:
    """Load the fused v4 LM if it is on disk, else None. Serving must never
    depend on it — every failure path returns None and the classical
    bundle keeps answering."""
    if not NEURAL_DIR or not (NEURAL_DIR / "config.json").exists():
        return None
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        tok = AutoTokenizer.from_pretrained(str(NEURAL_DIR),
                                            local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(
            str(NEURAL_DIR), dtype=torch.float32, local_files_only=True)
        model.eval()
        meta = json.load(open(NEURAL_DIR / "threshold.json"))
        return {
            "model": model,
            "tok": tok,
            "threshold": float(meta["respond_threshold"]),
            "version": meta.get("version", "neural"),
        }
    except Exception as exc:  # noqa: BLE001
        print(f"neural model unavailable, serving classical bundle: {exc!r}",
              flush=True)
        return None


def load_state() -> None:
    bundle = joblib.load(MODEL_DIR / "model.joblib")
    STATE["clf"] = bundle["clf"]
    STATE["version"] = bundle["version"]
    STATE["encoder"] = SentenceTransformer(str(MODEL_DIR / "embedding-model"))
    # v4+ bundles carry a respond threshold tuned on the selection VAL
    # carve; older bundles have none and keep plain argmax.
    if bundle.get("respond_threshold") is not None:
        STATE["respond_threshold"] = float(bundle["respond_threshold"])
    if bundle.get("feature_version"):
        STATE["priors"] = bundle["sender_priors"]
        STATE["seen"] = bundle["sender_seen"]
        STATE["global_rate"] = bundle["global_rate"]
        STATE["feature_version"] = bundle["feature_version"]
    STATE["neural"] = load_neural()


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


def neural_predict(neural: dict, email: EmailIn) -> tuple[str, dict]:
    """Label-token log-prob scoring, mirroring src/train_neural_v4.py:
    one forward per label over prompt+label tokens, summed logprobs,
    softmax across the three labels, respond iff the tuned threshold
    clears — else the best-scoring non-respond label."""
    import torch

    tok, model = neural["tok"], neural["model"]
    text = tok.apply_chat_template(
        [{"role": "user",
          "content": NEURAL_PROMPT.format(f=email.from_, s=email.subject,
                                           n=email.snippet)}],
        add_generation_prompt=True, tokenize=False)
    ids_prompt = tok.encode(text, add_special_tokens=False)
    scores: dict[str, float] = {}
    with torch.inference_mode():
        for label in ("respond", "archive", "mark-read"):
            ids_label = tok.encode(label, add_special_tokens=False)
            ids = torch.tensor([ids_prompt + ids_label], dtype=torch.long)
            logits = model(ids).logits[0]
            logprobs = torch.log_softmax(logits.float(), dim=-1)
            total = 0.0
            for k, t in enumerate(ids_label):
                total += float(logprobs[len(ids_prompt) + k - 1, t])
            scores[label] = total
    peak = max(scores.values())
    exps = {k: math.exp(v - peak) for k, v in scores.items()}
    z = sum(exps.values())
    probabilities = {k: exps[k] / z for k in exps}
    if probabilities["respond"] >= neural["threshold"]:
        label = "respond"
    else:
        label = max((k for k in probabilities if k != "respond"),
                    key=probabilities.get)
    return label, probabilities


@app.post("/predict", response_model=Prediction)
def predict(email: EmailIn) -> Prediction:
    if "clf" not in STATE:
        raise HTTPException(status_code=503, detail="model not loaded")
    started = time.perf_counter()
    neural = STATE.get("neural")
    if neural:
        label, probabilities = neural_predict(neural, email)
        return Prediction(
            label=label,
            probabilities={c: round(float(p), 4)
                           for c, p in probabilities.items()},
            model_version=str(neural["version"]),
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
        )
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
    threshold = STATE.get("respond_threshold")
    if threshold is not None and "respond" in classes:
        # mirrors src/train_v4.py's decision rule: respond iff the raw
        # respond probability clears the tuned threshold, else the argmax
        # of the remaining classes. Probabilities below stay the model's
        # raw predict_proba output.
        ri = classes.index("respond")
        if proba[ri] >= threshold:
            best = "respond"
        else:
            rest = [i for i, c in enumerate(classes) if c != "respond"]
            best = classes[max(rest, key=lambda i: proba[i])]
    else:
        best = max(zip(classes, proba), key=lambda pair: pair[1])[0]
    return Prediction(
        label=best,
        probabilities={c: round(float(p), 4) for c, p in zip(classes, proba)},
        model_version=str(STATE["version"]),
        latency_ms=round((time.perf_counter() - started) * 1000, 1),
    )
