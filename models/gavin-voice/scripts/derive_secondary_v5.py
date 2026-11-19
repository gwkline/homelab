#!/usr/bin/env python3
"""Derive the v5 era-tagged SECONDARY diagnostic holdout (#537 Option 1).

The secondary holdout (evals/holdout-secondary-v4.jsonl, 30 old-era rows:
12 email < 2021 + 18 text <= 2023) is FROZEN — never regenerated. But its
prompts are era-UNtagged, which after v5's era-conditioning would measure
the model answering old-era prompts in its untagged (recent-default) voice
— not the coexistence the lever claims. This script therefore derives
evals/holdout-secondary-v5.jsonl: the SAME rows and reals (byte-identical
`real`/`subject`), with prompts rebuilt through build_corpus's era-tagged
prompt functions so the diagnostic measures the old-era voice the era
conditioning is supposed to unlock. Aggregate output only. Diagnostic only
— the promote gate stays the untouched primary frozen holdout.
"""
import datetime
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import (APPLE_EPOCH, email_user_prompts, norm_text,  # noqa: E402
                           parse_mail_date, strip_subject, text_user_prompts)

D = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
SUBJ_RE = re.compile(r'(?:email thread|email with the subject):\s*"([^"]+)"')

emails = [json.loads(l) for l in open(f"{D}/corpus/email.jsonl")]
bursts = [json.loads(l) for l in open(f"{D}/corpus/texts.jsonl")]
by_subj = defaultdict(list)
for e in emails:
    by_subj[strip_subject(e["subject"]).casefold()].append(e)
by_real = {norm_text(b["text"]): b for b in bursts}

out, misses = [], 0
for h in [json.loads(l) for l in open(f"{D}/evals/holdout-secondary-v4.jsonl")]:
    row = dict(h)
    if h["channel"] == "email":
        m = SUBJ_RE.search(h["prompt"])
        cand = [e for e in by_subj.get(strip_subject(m.group(1)).casefold(), [])
                if norm_text(e["body"]) == norm_text(h.get("real") or "")] if m else []
        if not cand:
            misses += 1
        else:
            dt = parse_mail_date(cand[0]["date"])
            if dt:
                row["prompt"] = email_user_prompts(cand[0], era=dt.year)[0]
                row["era"] = dt.year
            else:
                misses += 1
    else:
        b = by_real.get(norm_text(h.get("real") or ""))
        if b is None:
            misses += 1
        else:
            try:
                dt = APPLE_EPOCH + datetime.timedelta(microseconds=b["ts"] / 1000)
            except (OverflowError, ValueError):
                dt = None
            if dt:
                row["prompt"] = text_user_prompts(b, era=dt.year)[0]
                row["era"] = dt.year
            else:
                misses += 1
    out.append(row)

with open(f"{D}/evals/holdout-secondary-v5.jsonl", "w") as f:
    for r in out:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

eras = defaultdict(int)
for r in out:
    if r.get("era"):
        eras[r["channel"]] += 1
print(json.dumps({"rows": len(out), "era_tagged": dict(eras),
                  "unmatched_or_undated": misses}))
