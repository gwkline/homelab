#!/usr/bin/env python3
"""Batch email-action classifier client for the 8:01 AM briefing.

SUGGESTION MODE ONLY: this script never archives, marks, deletes or sends
anything. It scores messages and logs predictions. The one exception to
"suggestion-only" lives downstream in auto_archive.py, which turns
Gavin's 2026-11-21 >0.9 auto-archive authority into a deterministic,
guarded candidate list; eligibility is decided there, never here and
never by the briefing agent's judgment.

Input: a JSON file (argv[1], or stdin) holding an array of messages as
fetched by the briefing via executor MCP metadata:

    [{"id": "<gmail message id>", "from": "...", "subject": "...",
      "snippet": "...", "labelIds": [...]}, ...]

`snippet` and `labelIds` are optional passthrough fields: they never
reach the prediction log, they only ride the stdout entries so the
auto-archive guard can match protected classes and the run manifest can
record original labels.

Behavior:
  1. Empty input -> {"ok": true, "count": 0, "predictions": []}; no API call.
  2. Health-probes GET {base}/healthz with a hard timeout (default 8s).
     Unreachable or slow -> {"ok": false, "degraded": true, "reason": ...}
     and NOTHING is logged: the briefing must render exactly as it would
     without the classifier. Exit code is always 0.
  3. POSTs each message to {base}/predict concurrently (2 workers; per-request
     timeout 8s; whole-batch budget 90s -- sized for the ~1.5-2.2s/inference
     neural-v4 backend, where a 30-message morning batch legitimately takes
     ~30-60s. The classical v1.5 era used 8 workers / 2s / 10s; that budget
     scores 0 messages against neural-v4, which is what darkened the log
     2026-11-19..21, see homelab #526). A failed/slow message degrades that
     message only (predicted: null, failed: true) and is not logged.
  4. Appends every scored message to the prediction log (JSONL): message id,
     predicted action, confidence, model version, timestamp -- the feedback
     loop a future v3 reconciles against what Gavin actually did. Auto-archived
     messages get their own log rows (auto_archive: true) from
     auto_archive.py's `log` step after the write is verified.

Output: one JSON object on stdout for the briefing agent to render, e.g.

    {"ok": true, "degraded": false, "model_version": "...", "count": 12,
     "predictions": [{"id": "...", "from": "...", "subject": "...",
                      "snippet": "...", "labelIds": [...],
                      "predicted": "respond", "confidence": 0.62,
                      "probabilities": {...}, "model_version": "...",
                      "failed": false}, ...]}

Each entry carries its own model_version (what actually scored it), so the
auto-archive guard can refuse classical-fallback rows even when the
service flips mid-batch.

Env knobs (all optional):
  EMAIL_CLASSIFIER_URL    predict endpoint (probe swaps /predict for /healthz)
  EMAIL_CLASSIFIER_LOG    JSONL log path
  EMAIL_CLASSIFIER_TIMEOUT  per-request timeout seconds (default 8)
  EMAIL_CLASSIFIER_BUDGET  whole-batch budget seconds (default 90)
  EMAIL_CLASSIFIER_WORKERS  concurrent in-flight requests (default 1)

Worker count is 1, not 2, on purpose: the fp32 neural rides a 7Gi-limited
pod, and a 2-worker burst OOMKilled it mid-batch on 2026-11-22 (5
restarts, exit 137) — single-pass concurrency keeps the peak inside the
envelope the morning run already survives. A 30-message briefing at
~2 s/message still fits the default 90 s budget.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.request

# The tailnet DNS suffix is runtime config, never committed (the repo's
# verify.sh policy). The live copy beside the prediction log carries the
# real URL as its default; EMAIL_CLASSIFIER_URL overrides either copy.
DEFAULT_URL = os.environ.get(
    "EMAIL_CLASSIFIER_URL", "https://email-classifier.<tailnet>.ts.net/predict"
)
DEFAULT_LOG = str(
    pathlib.Path.home() / "git-dev/email-classifier-local/predictions/predictions.jsonl"
)
DEFAULT_TIMEOUT = 8.0
DEFAULT_BUDGET = 90.0
DEFAULT_WORKERS = 1


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")


def degraded(reason: str) -> None:
    emit({"ok": False, "degraded": True, "reason": reason, "predictions": []})


def probe(base_url: str, timeout: float) -> str | None:
    """Return the model_version on success, else None (caller degrades)."""
    health = base_url.rsplit("/", 1)[0] + "/healthz"
    try:
        with urllib.request.urlopen(health, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
        if resp.status == 200 and body.get("ok"):
            return str(body.get("model_version", ""))
    except Exception:
        pass
    return None


def score_one(url: str, msg: dict, timeout: float) -> dict | None:
    """POST one message; return the API's Prediction or None on any failure."""
    payload = {
        "from": msg.get("from", ""),
        "subject": msg.get("subject", ""),
        "snippet": msg.get("snippet", ""),
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None


def log_predictions(path: str, rows: list[dict]) -> None:
    if not rows:
        return
    pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=True) + "\n")


def main() -> None:
    url = os.environ.get("EMAIL_CLASSIFIER_URL") or DEFAULT_URL
    log_path = os.environ.get("EMAIL_CLASSIFIER_LOG") or DEFAULT_LOG
    timeout = env_float("EMAIL_CLASSIFIER_TIMEOUT", DEFAULT_TIMEOUT)
    budget = env_float("EMAIL_CLASSIFIER_BUDGET", DEFAULT_BUDGET)
    workers = env_int("EMAIL_CLASSIFIER_WORKERS", DEFAULT_WORKERS)

    raw = pathlib.Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else sys.stdin.read()
    try:
        messages = json.loads(raw)
        if not isinstance(messages, list):
            raise ValueError("input must be a JSON array")
    except Exception as exc:
        degraded(f"bad input: {exc}")
        return

    messages = [m for m in messages if isinstance(m, dict) and m.get("id")]
    if not messages:
        emit({"ok": True, "degraded": False, "model_version": None,
              "count": 0, "predictions": []})
        return

    version = probe(url, timeout)
    if version is None:
        degraded(f"classifier unreachable or slower than {timeout}s at {url}")
        return

    def blank(msg: dict) -> dict:
        return {
            "id": msg.get("id"),
            "from": msg.get("from", ""),
            "subject": msg.get("subject", ""),
            "snippet": msg.get("snippet", ""),
            "labelIds": msg.get("labelIds", []),
            "failed": True,
            "predicted": None,
            "confidence": None,
            "probabilities": None,
            "model_version": None,
        }

    predictions: dict[object, dict] = {}
    logged: list[dict] = []
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    futures = {pool.submit(score_one, url, msg, timeout): msg for msg in messages}
    try:
        for fut in concurrent.futures.as_completed(futures, timeout=budget):
            msg = futures[fut]
            try:
                pred = fut.result()
            except Exception:
                pred = None
            entry = blank(msg)
            if pred is not None and pred.get("label"):
                entry["failed"] = False
                entry["predicted"] = pred["label"]
                entry["confidence"] = pred.get("probabilities", {}).get(
                    pred["label"]
                )
                entry["probabilities"] = pred.get("probabilities")
                entry["model_version"] = str(
                    pred.get("model_version") or version or ""
                )
                logged.append(
                    {
                        "ts": dt.datetime.now().astimezone().isoformat(
                            timespec="seconds"
                        ),
                        "message_id": msg.get("id"),
                        "from": msg.get("from", ""),
                        "subject": msg.get("subject", ""),
                        "predicted": pred["label"],
                        "confidence": entry["confidence"],
                        "model_version": entry["model_version"],
                    }
                )
            predictions[id(msg)] = entry
    except concurrent.futures.TimeoutError:
        pass  # budget blown; un-scored messages degrade individually below
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    for msg in messages:
        predictions.setdefault(id(msg), blank(msg))
    ordered = [predictions[id(msg)] for msg in messages]
    log_predictions(log_path, logged)
    if not version and logged:
        version = str(logged[0].get("model_version") or "")
    emit(
        {
            "ok": True,
            "degraded": False,
            "model_version": version,
            "count": len(ordered),
            "predictions": ordered,
        }
    )


if __name__ == "__main__":
    main()
