#!/usr/bin/env python3
"""Deterministic auto-archive guard for the 8:01 AM briefing pipeline.

Authority (Gavin, 2026-11-21, verbatim): "I want you to take action for
super high prob actions. If >.9, you have permission to archive." This
script turns that grant into code: it reads classify.py's output and
picks the exact set of messages the authority covers — never more. It is
a GUARD, not an actor: it never touches Gmail. The briefing session
executes the emitted list (one batchModify per the plan's `write` hint:
remove INBOX, keep UNREAD), verifies each write by readback, then logs.

Eligibility — ALL must hold, evaluated per message:
  1. the row was scored by the NEURAL model (model_version starts with
     "neural-"). Only the neural's calibrated probability qualifies; a
     classical-fallback day skips auto-archiving entirely and the
     briefing says so.
  2. predicted action is "archive" — anything flagged respond or
     mark-read is protected.
  3. P(archive) > 0.9 and P(respond) < 0.05, strict.
  4. not in a protected class, matched over from+subject+snippet:
     security/2FA/login, shipping/delivery (the latest update stays
     until confirmed receipt), transactional receipts/orders/billing,
     calendar invites, travel/reservation logistics, GovDash streams.
     These patterns are deliberately over-inclusive: a false protect
     only leaves mail in the inbox, a false archive removes something
     Gavin may need.
  5. within the run cap (default 50).

Everything else — respond/mark-read suggestions, sends, filters,
unsubscribes — stays in the existing confirmation flow. If Gavin
re-inboxes an auto-archived message, that is the negative-outcome signal
for the retrain loop: `log` records every archive to predictions.jsonl
so a later reconciliation can look for exactly that.

Usage:
  auto_archive.py plan <classify-output.json> [--cap N]
      Reads classify.py's stdout JSON (file path or "-"); emits the plan
      as one JSON object on stdout. Exit code is always 0.
  auto_archive.py log <verified.json>
      Appends one auto_archive row per VERIFIED archive to
      EMAIL_CLASSIFIER_LOG (default predictions.jsonl). Input rows come
      from the plan's qualifying set plus the readback verification:
      [{"id", "from", "subject", "predicted", "confidence",
        "p_archive", "p_respond", "model_version", "verified": true}].
      Rows keep the existing log schema and add auto_archive / p_archive
      / p_respond / write / verified. Snippets are never logged.

Env knobs (optional):
  EMAIL_CLASSIFIER_LOG    JSONL log path (same file classify.py uses)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys

NEURAL_PREFIX = "neural-"
P_ARCHIVE_MIN = 0.9   # strict greater-than
P_RESPOND_MAX = 0.05  # strict less-than
DEFAULT_CAP = 50

# Protected classes: (name, pattern) over "from | subject | snippet".
# Over-inclusive on purpose — see module docstring.
PROTECTED_TEXT: list[tuple[str, re.Pattern[str]]] = [
    (
        "security",
        re.compile(
            r"security alert|suspicious|phish|\bscam\b|"
            r"sign[- ]?in|signed in|log[ -]?in|logged in|"
            r"verification code|verify (?:your|this|identity|email|account)|"
            r"one[- ]time (?:code|passcode|password)|2[- ]?fa|two[- ]factor|"
            r"\bpasscode|\bpassword|reset (?:your|my) (?:password|passcode)|"
            r"authenticate|authorization code|"
            r"unusual (?:activity|sign[- ]?in|location)|new device|"
            r"access (?:attempt|request|granted|denied)|"
            r"confirm (?:your|the) (?:identity|account|email)|"
            r"\botp\b|don'?t recognize|account (?:recovery|locked|disabled|"
            r"compromised|on hold)|protect (?:your|the) account|"
            r"accounts\.google\.com|appleid\.apple\.com|login\.microsoft|"
            r"1password|okta\.com|security@|@accounts\.|id\.apple\.com|"
            # credential-lifecycle notices (GitHub PAT added, exposed
            # secrets, key rotation) are security mail even when the
            # classifier has learned to archive them
            r"personal access token|\baccess tokens?\b|\bapi[_ -]?keys?\b|"
            r"\bssh keys?\b|"
            r"token (?:has been|was) (?:added|created|generated|revoked|"
            r"expired|renewed)|"
            r"credentials? (?:were|was|are|have been)? ?(?:added|created|"
            r"rotated|exposed|leaked|compromised|reset)|"
            r"passwords? (?:detected|exposed|leaked|compromised|found)|"
            r"secret scanning|key rotation|signing key",
            re.I,
        ),
    ),
    (
        "shipping",
        re.compile(
            r"\bships?\b|\bshipping\b|\bshipped\b|\bshipment\b|"
            r"out for delivery|\bdelivered\b|\bdeliveries\b|\bdelivery\b|"
            r"in transit|arriving|on its way|\bpackage\b|\bparcel\b|"
            r"tracking (?:number|#|\bcode\b)|\busps\b|\bups\b|fedex|\bdhl\b|"
            r"ontrac|lasership|postal|carrier facility|delivery attempt|"
            r"drop[ -]?off|pick[ -]?up (?:your|the|point|location)|"
            r"return (?:window|label|request)|customs|\bcourier\b",
            re.I,
        ),
    ),
    (
        "receipt",
        re.compile(
            r"\breceipts?\b|your order|order (?:confirmation|#|number|placed|"
            r"summary|update)|\binvoices?\b|"
            r"payment (?:received|confirmed|failed|declined|method|updated|"
            r"successful|due|reminder)|\bpaid\b|purchased|"
            r"purchase (?:confirmation|complete|receipt)|"
            r"transaction (?:id|receipt|complete|#)|\bstatements?\b|"
            r"\bbilling\b|renewal|renewed|\bcharged\b|\brefunds?\b|"
            r"thank (?:you|you again) for your order",
            re.I,
        ),
    ),
    (
        "calendar",
        re.compile(
            r"calendar-notification|\binvitations?\b|invited you|\brsvp\b|"
            r"event (?:invite|invitation|update|starting|reminder|declined|"
            r"accepted|schedule)|calendar (?:invite|event|reminder)|"
            r"updated invitation|\bics\b",
            re.I,
        ),
    ),
    (
        "travel",
        re.compile(
            r"\breservations?\b|\bitinerar(?:y|ies)\b|\bbookings?\b|"
            r"check[ -]?ins?\b|\bflights?\b|\bhotels?\b|\brentals?\b|"
            r"airlines?\b|boarding pass|airport|booked (?:your|a)|"
            r"\btrips?\b",
            re.I,
        ),
    ),
    (
        "govdash",
        re.compile(r"govdash", re.I),
    ),
]


def _num(v: object) -> float | None:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def evaluate(entry: dict) -> tuple[bool, str]:
    """Return (eligible, reason) for one classify.py stdout entry."""
    if entry.get("failed") or not entry.get("probabilities"):
        return False, "prediction_failed"
    p_archive = _num(entry["probabilities"].get("archive"))
    p_respond = _num(entry["probabilities"].get("respond"))
    if p_archive is None or p_respond is None:
        return False, "probabilities_missing"
    if not str(entry.get("model_version") or "").startswith(NEURAL_PREFIX):
        return False, "classical_row"
    if entry.get("predicted") != "archive":
        return False, f"flagged:{entry.get('predicted')}"
    if not p_archive > P_ARCHIVE_MIN:
        return False, f"p_archive<={P_ARCHIVE_MIN}"
    if not p_respond < P_RESPOND_MAX:
        return False, f"p_respond>={P_RESPOND_MAX}"
    text = " | ".join(
        str(entry.get(k) or "") for k in ("from", "subject", "snippet")
    )
    for name, pat in PROTECTED_TEXT:
        if pat.search(text):
            return False, f"protected:{name}"
    return True, "ok"


def gate_status(classify_output: dict) -> tuple[str, str | None]:
    """Day-level model gate plus the briefing note when auto-archive is off."""
    if not classify_output.get("ok") or classify_output.get("degraded"):
        return "degraded", (
            "Classifier degraded or unreachable this run -- no auto-archive; "
            "briefing renders as without the classifier."
        )
    preds = [p for p in classify_output.get("predictions", [])
             if isinstance(p, dict)]
    scored = [p for p in preds if not p.get("failed")]
    if not scored:
        return "no_predictions", (
            "No predictions completed this run -- no auto-archive."
        )
    neural = [p for p in scored
              if str(p.get("model_version") or "").startswith(NEURAL_PREFIX)]
    if not neural:
        return "classical_fallback", (
            "Classifier served the classical fallback today -- auto-archive "
            "skipped (only the neural model's calibrated probability "
            "qualifies)."
        )
    if len(neural) < len(scored):
        return "mixed", (
            "Mixed model eras in today's batch -- only neural-scored rows "
            "were eligible; classical-fallback rows were skipped."
        )
    return "neural", None


def plan(classify_output: dict, cap: int) -> dict:
    """Build the deterministic auto-archive plan from classify.py's output."""
    gate, note = gate_status(classify_output)
    entries = [p for p in classify_output.get("predictions", [])
               if isinstance(p, dict) and p.get("id")]
    qualifying, skipped = [], []
    for entry in entries:
        probs = entry.get("probabilities") or {}
        row = {
            "id": entry.get("id"),
            "from": entry.get("from", ""),
            "subject": entry.get("subject", ""),
            "predicted": entry.get("predicted"),
            "p_archive": _num(probs.get("archive")),
            "p_respond": _num(probs.get("respond")),
            "model_version": entry.get("model_version"),
        }
        eligible, reason = evaluate(entry)
        if eligible:
            qualifying.append(row)
        else:
            row["reason"] = reason
            skipped.append(row)

    # Most confident first; stable tie-break on message id.
    qualifying.sort(key=lambda r: (-(r["p_archive"] or 0.0), str(r["id"])))
    deferred = qualifying[cap:]
    qualifying = qualifying[:cap]

    out = {
        "ok": True,
        "gate": gate,
        "model_version": classify_output.get("model_version"),
        "total": len(entries),
        "cap": cap,
        "write": {"removeLabelIds": ["INBOX"], "keep": ["UNREAD"]},
        "qualifying": qualifying,
        "skipped": skipped,
        "briefing_note": note,
    }
    if deferred:
        for row in deferred:
            row["reason"] = "over_cap"
        out["deferred_over_cap"] = deferred
    return out


def append_log(log_path: str, rows: list[dict]) -> int:
    """Append verified auto-archive rows to the prediction log."""
    pathlib.Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with open(log_path, "a", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=True) + "\n")
            written += 1
    return written


def log_rows(verified: list[dict]) -> list[dict]:
    """Shape verified archives into prediction-log rows, or raise."""
    rows = []
    for item in verified:
        if not isinstance(item, dict) or not item.get("id"):
            raise ValueError("log input rows need an id")
        if item.get("verified") is not True:
            raise ValueError(
                f"refusing to log unverified row {item.get('id')}"
            )
        if item.get("predicted") != "archive":
            raise ValueError(
                f"refusing to log non-archive row {item.get('id')}"
            )
        rows.append(
            {
                "ts": dt.datetime.now().astimezone().isoformat(
                    timespec="seconds"
                ),
                "message_id": item.get("id"),
                "from": item.get("from", ""),
                "subject": item.get("subject", ""),
                "predicted": "archive",
                "confidence": item.get("confidence"),
                "model_version": item.get("model_version"),
                "auto_archive": True,
                "p_archive": item.get("p_archive"),
                "p_respond": item.get("p_respond"),
                "write": "remove_INBOX_keep_UNREAD",
                "verified": True,
            }
        )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(
        description=(__doc__ or "auto-archive guard").splitlines()[0]
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    planp = sub.add_parser("plan", help="guard classify.py output -> plan JSON")
    planp.add_argument("input", help="classify.py stdout JSON path, or '-'")
    planp.add_argument("--cap", type=int, default=DEFAULT_CAP,
                       help=f"max auto-archives per run (default {DEFAULT_CAP})")

    logp = sub.add_parser("log", help="append verified archives to the log")
    logp.add_argument("input", help="verified rows JSON path, or '-'")

    args = ap.parse_args()
    log_path = os.environ.get("EMAIL_CLASSIFIER_LOG") or str(
        pathlib.Path.home()
        / "git-dev/email-classifier-local/predictions/predictions.jsonl"
    )

    raw = (sys.stdin.read() if args.input == "-"
           else pathlib.Path(args.input).read_text())
    data = json.loads(raw)

    if args.cmd == "plan":
        emit = plan(data, args.cap)
    else:
        rows = log_rows(data if isinstance(data, list) else [])
        emit = {
            "ok": True,
            "logged": append_log(log_path, rows),
            "log_path": log_path,
        }
    sys.stdout.write(json.dumps(emit, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
