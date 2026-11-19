#!/usr/bin/env python3
"""Leak checks for the gavin-voice corpus — run BEFORE every training run.

Re-runs the exact v2.2 holdout-twin leak discipline (the checks that caught
two holdout-twin leaks in corpus v2.2) against BOTH the primary frozen
holdout (evals/holdout.jsonl, sha 14013551...) and the v4 era-stratified
secondary holdout (evals/holdout-secondary-v4.jsonl):

  1. primary holdout byte-identity (sha256 must equal the frozen value)
  2. assistant-twin: no train/valid assistant content equals a holdout real
     (whitespace-normalized)
  3. subject/topic-twin: no train/valid email prompt carries a held-out
     subject (topic-level: Re/Fwd stripped, casefolded)
  4. incoming-twin: no train/valid prompt embeds a holdout email real
     (first-80-normalized-chars prefix match, the v3 incoming-block guard)
  5. text-twin: no train/valid text example answers a held-out text real
  6. artifact bar: ZERO '+'-prefixed assistant rows and ZERO '+'-prefixed
     holdout reals (streamtyped decode leak — non-negotiable)

Aggregate output only (counts, never message text). Exit 0 iff all checks
pass for both holdouts.
"""
import hashlib
import json
import os
import re
import sys

D = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
PRIMARY = f"{D}/evals/holdout.jsonl"
SECONDARY = f"{D}/evals/holdout-secondary-v4.jsonl"
FROZEN_SHA = "14013551ce174c5bcb1454e10c2429a2fd38e4331dcd98448fcd82db06581627"

SUBJ_RE = re.compile(r'(?:email thread|email with the subject):\s*"(.+)"\s*$')
SUBJ_ANY_RE = re.compile(r'(?:email thread|email with the subject):\s*"([^"]+)"')
STRIP_RE = re.compile(r'^(Re|Fwd|FW)\s*:\s*', re.I)


def norm(t):
    return " ".join((t or "").split())


def load(path):
    return [json.loads(l) for l in open(path).read().splitlines() if l.strip()]


def assistant_of(ex):
    for m in ex.get("messages", []):
        if m.get("role") == "assistant":
            return m.get("content", "")
    return ""


def user_of(ex):
    for m in ex.get("messages", []):
        if m.get("role") == "user":
            return m.get("content", "")
    return ""


def check(label, holdout, train, valid, require_sha=None):
    results = {}
    if require_sha:
        sha = hashlib.sha256(open(require_sha["path"], "rb").read()).hexdigest()
        results["primary_sha"] = {"expected": require_sha["sha"], "actual": sha,
                                  "pass": sha == require_sha["sha"]}

    reals = {norm(h["real"]) for h in holdout if h.get("real")}
    email_reals80 = [norm(h["real"])[:80] for h in holdout
                     if h.get("channel") == "email" and h.get("real")]
    text_reals = {norm(h["real"]) for h in holdout
                  if h.get("channel") == "text" and h.get("real")}
    subjects, topics = set(), set()
    for h in holdout:
        if h.get("channel") != "email":
            continue
        m = SUBJ_RE.search(h.get("prompt", ""))
        if m:
            subjects.add(m.group(1).strip())
            topics.add(STRIP_RE.sub("", m.group(1)).strip().casefold())

    exs = [("train", e) for e in train] + [("valid", e) for e in valid]

    n_twin = n_inc = n_subj = n_text = n_plus = 0
    for which, ex in exs:
        a, u = norm(assistant_of(ex)), user_of(ex)
        if a in reals:
            n_twin += 1
        if any(r and r in u for r in email_reals80):
            n_inc += 1
        # v4 twin rule, mirroring build_corpus: an email prompt's OWN subject
        # must not equal a held-out subject/topic, and an email-form prompt
        # must not embed a SPECIFIC (multi-word, >=12 char) held-out topic
        # phrase in its quoted incoming — same-thread siblings leak thread
        # content through renamed subjects.
        subj_leak = False
        m = SUBJ_ANY_RE.search(u)
        if m:
            own = m.group(1).strip()
            if own in subjects or STRIP_RE.sub("", own).strip().casefold() in topics:
                subj_leak = True
            elif any(len(t) >= 12 and " " in t and t in own.casefold()
                     for t in topics):
                # near-twin subject (boilerplate profile phrases)
                subj_leak = True
        if (not subj_leak and m is not None
                and any(len(t) >= 12 and " " in t and t in u.casefold()
                        for t in topics)):
            subj_leak = True
        if subj_leak:
            n_subj += 1
        if a in text_reals:
            n_text += 1
        if assistant_of(ex).lstrip().startswith("+"):
            n_plus += 1
    holdout_plus = sum(1 for h in holdout
                       if (h.get("real") or "").lstrip().startswith("+"))

    results.update({
        f"{label}_assistant_twin": {"hits": n_twin, "pass": n_twin == 0},
        f"{label}_subject_topic_twin": {"hits": n_subj, "pass": n_subj == 0},
        f"{label}_incoming_twin": {"hits": n_inc, "pass": n_inc == 0},
        f"{label}_text_twin": {"hits": n_text, "pass": n_text == 0},
        f"{label}_plus_artifacts_train": {"hits": n_plus, "pass": n_plus == 0},
        f"{label}_plus_artifacts_holdout": {"hits": holdout_plus,
                                            "pass": holdout_plus == 0},
    })
    return results


def main():
    train = load(f"{D}/data/train.jsonl")
    valid = load(f"{D}/data/valid.jsonl")
    primary = load(PRIMARY)
    out = {"rows": {"train": len(train), "valid": len(valid),
                    "primary_holdout": len(primary)}, "checks": {}}

    out["checks"].update(check("primary", primary, train, valid,
                               require_sha={"path": PRIMARY, "sha": FROZEN_SHA}))
    if os.path.exists(SECONDARY):
        sec = load(SECONDARY)
        out["rows"]["secondary_holdout"] = len(sec)
        out["checks"].update(check("secondary", sec, train, valid))
    else:
        out["checks"]["secondary"] = {"pass": False,
                                      "error": "secondary holdout missing"}

    all_pass = all(v.get("pass", False) for v in out["checks"].values())
    out["overall"] = "PASS" if all_pass else "FAIL"
    path = f"{D}/evals/leak-check-v4.json"
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps(out, indent=2))
    print(f"wrote {path}")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
