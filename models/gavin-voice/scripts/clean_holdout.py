#!/usr/bin/env python3
"""One-time v2.1 cleanup of the frozen holdout (issue #528).

The frozen holdout is v1-era: its TEXT exemplars carry the streamtyped
'+' + length-byte leak (25/60 rows, e.g. '+ Oh sorry...', '+4My slumber…'
— the leak sits on EVERY burst part, not just the first line) and
reaction-junk rows the v2.1 builder never emits. Clean generations were
being scored against dirty exemplars, so every judge/ppl/format number
since v1 is penalized for correctness. This applies the SAME rules as
scripts/build_corpus.py v2.1 — per-line strip ^\\. before tapback-check,
garbage/junk/tapback filters, incoming-context strip — to the frozen
file IN PLACE, keeping split membership fixed (same exemplars, cleaned
text; no re-sampling, no membership change).

Email/blog rows are verified clean and passed through unchanged.

Outputs:
  evals/holdout.jsonl                cleaned + re-frozen standing holdout
  evals/holdout.v1-dirty.jsonl       archived original (personal, never committed)
  evals/holdout-clean-proof.json     sha256 before/after + zero-artifact proof
                                     (aggregate only — safe to commit)

Idempotent: refuses to run twice (the archive doubles as the guard).
"""
import hashlib
import json
import os
import re
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import LEAK_PREFIX, TAPBACK, text_is_garbage, norm_text  # noqa: E402

D = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
HOLDOUT = f"{D}/evals/holdout.jsonl"
ARCHIVE = f"{D}/evals/holdout.v1-dirty.jsonl"
PROOF = f"{D}/evals/holdout-clean-proof.json"

JUNK_FULLMATCH = re.compile(r"[\d\s\-\.\/+]{3,}")
PROMPT_RE = re.compile(r'^Reply to this text from (.*?): "(.*)"$', re.S)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def clean_lines(t):
    """Per burst-part strip, exactly like build_texts() applies per message:
    strip '^+.' first, then the caller tapback-checks the stripped text."""
    out = []
    for ln in (t or "").split("\n"):
        ln = LEAK_PREFIX.sub("", ln, count=1).strip()
        if ln:
            out.append(ln)
    return "\n".join(out)


def burst_survives(joined):
    """build_texts() burst-level filters, same order."""
    joined = (joined or "").strip()
    if not joined or text_is_garbage(joined):
        return None
    if JUNK_FULLMATCH.fullmatch(joined):
        return None
    if TAPBACK.match(joined):
        return None
    return joined


def clean_row(row, counters):
    ch = row.get("channel")
    real = row.get("real")
    if ch != "text" or not isinstance(real, str):
        # email/blog/task-style: verify-only pass, row kept as-is
        return row
    cleaned = clean_lines(real)
    if any(LEAK_PREFIX.match(ln) for ln in real.split("\n")):
        counters["real_lines_stripped"] += 1
    survivor = burst_survives(cleaned)
    if survivor is None:
        counters["dropped"] += 1
        counters["dropped_reason"]["tapback_or_junk" if cleaned else "empty_after_strip"] += 1
        return None
    row = dict(row)
    if survivor != real:
        row["real"] = survivor
    # prompt: strip the leak inside the quoted incoming context; a
    # tapback incoming never becomes context (v2.1) -> no-incoming form.
    m = PROMPT_RE.match(row.get("prompt", ""))
    if m:
        name, inc = m.group(1), m.group(2)
        inc_clean = clean_lines(inc)
        if not inc_clean or TAPBACK.match(inc_clean):
            row["prompt"] = f"Text {name}."
            counters["prompt_no_incoming_form"] += 1
        elif inc_clean != inc:
            row["prompt"] = f'Reply to this text from {name}: "{inc_clean}"'
            counters["prompt_incoming_cleaned"] += 1
    return row


def verify(rows):
    """The acceptance check: ZERO '+'-prefixed exemplars / incoming context,
    across ALL channels — measured, not assumed."""
    bad_real, bad_prompt, per_ch = 0, 0, {}
    for r in rows:
        ch = r.get("channel")
        c = per_ch.setdefault(ch, {"n": 0, "plus_real": 0, "plus_prompt": 0})
        c["n"] += 1
        real = r.get("real")
        if isinstance(real, str):
            if any(LEAK_PREFIX.match(ln) for ln in real.split("\n")):
                bad_real += 1
                c["plus_real"] += 1
        m = PROMPT_RE.match(r.get("prompt", "") or "")
        if m and any(LEAK_PREFIX.match(ln) for ln in m.group(2).split("\n")):
            bad_prompt += 1
            c["plus_prompt"] += 1
    return bad_real, bad_prompt, per_ch


def main():
    if os.path.exists(ARCHIVE):
        print(f"archive already exists ({ARCHIVE}) — holdout appears cleaned; aborting "
              "so a second run can't double-strip. Delete the archive to force.")
        sys.exit(1)
    raw = open(HOLDOUT).read()
    sha_old = sha256(HOLDOUT)
    rows = [json.loads(l) for l in raw.splitlines() if l.strip()]

    bad_real, bad_prompt, per_before = verify(rows)
    counters = {"real_lines_stripped": 0, "dropped": 0,
                "dropped_reason": {"tapback_or_junk": 0, "empty_after_strip": 0},
                "prompt_incoming_cleaned": 0, "prompt_no_incoming_form": 0}
    cleaned = []
    for r in rows:
        c = clean_row(r, counters)
        if c is not None:
            cleaned.append(c)

    bad_real2, bad_prompt2, per_after = verify(cleaned)
    if bad_real2 or bad_prompt2:
        print(f"VERIFICATION FAILED: {bad_real2} exemplar lines / {bad_prompt2} "
              "prompt lines still match '^+.' — NOT freezing this file.")
        sys.exit(2)

    with open(ARCHIVE, "w") as f:
        f.write(raw)
    with open(HOLDOUT, "w") as f:
        for r in cleaned:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    sha_new = sha256(HOLDOUT)

    proof = {
        "cleaned_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "rules": "identical to build_corpus.py v2.1 (imported from it): per-line "
                 "strip ^\\+. before tapback-check; garbage/junk/tapback filters; "
                 "incoming-context strip; tapback incoming -> no-incoming prompt form",
        "sha256_v1_dirty": sha_old,
        "sha256_v2_1_clean": sha_new,
        "rows_before": {k: v["n"] for k, v in per_before.items()},
        "rows_after": {k: v["n"] for k, v in per_after.items()},
        "plus_prefixed_before": {"real_exemplars": bad_real, "prompt_incoming": bad_prompt},
        "plus_prefixed_after": {"real_exemplars": bad_real2, "prompt_incoming": bad_prompt2},
        "zero_artifact_check": "PASS" if (bad_real2 == 0 and bad_prompt2 == 0) else "FAIL",
        "mutations": counters,
        "membership": "fixed — same exemplars as the v1 freeze, text cleaned in "
                       "place; tapback/junk rows v2.1 would never emit are dropped; "
                       "email/blog passed through (verified clean); no re-sampling",
    }
    with open(PROOF, "w") as f:
        json.dump(proof, f, indent=2)
    print(json.dumps(proof, indent=2))
    print(f"\narchived original -> {ARCHIVE}")
    print(f"proof              -> {PROOF}")


if __name__ == "__main__":
    main()
