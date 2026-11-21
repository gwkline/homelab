#!/usr/bin/env python3
"""Build corpus v8 — modality/formality conditioning on the all-time corpus.

USER MANDATE (2026-11-21, verbatim): "On the voice, I actually think I prefer
the old one. Maybe it would make sense to use my all time corpus of content,
and train based on the output modality/formality. E.g. I speak very
differently in slack than email, or on twitter than over text."

Card t_f1e6690b design, implemented as a standalone builder over the shared
build_corpus.py machinery (imported, never copied where importable):

  1. EMAIL — ALL-TIME (2013->now), era-tagged where old (< 2023-09, the v5
     mechanism byte-for-byte). The old email register becomes
     request-selectable; email is the proven basin-free channel.
  2. TEXT — RECENT window only (texts_raw.v3.jsonl, the preserved v3 raw
     extract, 2024-06->now; MAX_TEXT_EXAMPLES=3000). The standing no-basin
     rule applied UP FRONT from the measured v7 2x2 map: every corpus that
     included old-era texts trained the "I think…" basin in at every rank and
     lr (v5/v6/v7a basin-present at val-best); the only basin-free runs
     (v3, v7b) had recent-only text. This is the card's own fallback
     ("otherwise drop them and note it"), not a new date-drop: the
     mandate's era-DROPPING prohibition applies to EMAIL, which keeps
     every row back to account start. The basin watch verifies.
  3. BLOG — all rows, channel-named prompts (unchanged mechanism).
  4. MODALITY CONDITIONING — every user turn names its channel (as in every
     prior version) and the phrasing families are EXTENDED with
     instruction-style register-naming forms ("write an email about X",
     "write a short post about X", "send a quick text") so request-time
     register selection generalizes. Option [0] of every family is
     byte-identical to v3/v5 — the frozen primary holdout's prompt form
     stays the in-distribution default. Subject-carrying email forms keep
     the 'email thread: "…"' carrier so leak_check.py's subject regex still
     audits every one of them.
  5. INSTRUCTION MIX — general instruction data stays 25%, but rows whose
     request names a writing channel (email/text/tweet/blog/post/letter/
     memo/slack — 1.8% of the pool) are EXCLUDED so a channel-naming
     request maps unambiguously to the personal register it names instead
     of a generic alpaca answer.

Reproducibility bars for this build (checked after it runs):
  - corpus/email-v8.jsonl byte-identical to the parked corpus/email-v5.jsonl
    (the email channel is the v5 channel, unchanged mechanism).
  - text fingerprint = corpus v3's (16,934 bursts / 337 chats / by-year
    2024: 3235, 2025: 6888, 2026: 6811), 5,996 text examples.
  - era-tagged rows: email ~1,064 (v5's count, same pool), text 0.
  - Frozen primary holdout untouched (sha 14013551…); secondary v4 rows
    excluded from training with the same twin-leak discipline; leak_check
    13/13 PASS required before training.

New modalities (X/Twitter, Slack): NOT in this build. No X/Twitter toolset
or credentials exist in this environment (checked 2026-11-21: no x_search
tools across the 113 available, no matching env vars, no archive export in
~/Downloads) — the user's X archive download would unlock it. No local
Slack source exists; a user-provided export would unlock it. Non-blocking
per the card.
"""
import datetime
import json
import os
import random
import re
import statistics
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_corpus as bc  # noqa: E402

random.seed(42)

D = bc.D
CORPUS, DATA, EVALS = bc.CORPUS, bc.DATA, bc.EVALS
GENERIC_SYSTEM = bc.GENERIC_SYSTEM
EMAIL_MIN_DATE = "1970-01-01"          # all-time email (mandate)
MAX_TEXT_EXAMPLES = 3000                # v3 recent-text window sizing
TEXTS_SOURCE = os.environ.get(
    "V8_TEXTS_SOURCE", f"{CORPUS}/texts_raw.v3.jsonl")  # preserved v3 raw

# Writing-channel-naming instruction rows to EXCLUDE from the instruction
# mix (see docstring point 5). Same pattern used to size the exclusion.
WRITING_CHANNEL_RE = re.compile(
    r'\b(e-?mail|text message|tweet|slack|blog|post about'
    r'|write (a|an) (letter|memo))\b', re.I)

OUT_TAG = os.environ.get("V8_OUT_TAG", "v8-20261121")


# ----------------------------------------------------- v8 prompt families
# Every family = the v3/v5 option list (option [0] byte-identical, the
# frozen-holdout form) + new instruction-style, channel-naming forms. The
# channel keyword appears in every option; era mirrors follow the v5
# natural-phrasing pattern.
def email_user_prompts_v8(rec, era=None):
    opts = bc.email_user_prompts(rec, era=era)  # v3/v5 forms, [0] intact
    subj, topic = rec["subject"], bc.strip_subject(rec["subject"])
    name = rec["recipient_first"]
    inc, inc_from = rec.get("incoming"), rec.get("incoming_from")
    if inc:
        author = inc_from or name or "The sender"
        opts.append((f'Answer this {era} email thread: "{subj}"' if era else
                     f'Answer this email thread: "{subj}"')
                    + f'\n\n{author} wrote:\n"{inc}"')
        if not era:
            opts.append(f'{author} sent an email I need to answer '
                        f'(subject: "{subj}").\n\n"{inc}"')
        return opts
    if re.match(r'^(Re|FW|Fwd)\s*:', subj, re.I):
        opts.append(f'Answer this {era} email thread: "{subj}"' if era else
                    f'Answer this email thread: "{subj}"')
        opts.append(f'Write the reply for this {era} email thread: "{subj}"'
                    if era else f'Write the reply for this email thread: "{subj}"')
        if name and not era:
            opts.append(f'{name} needs a reply to the email thread: "{subj}"')
        return opts
    if era:
        opts.append(f'Compose a {era} email about {topic}')
        if name:
            opts.append(f'Compose a {era} email to {name} about {topic}')
    else:
        opts.append(f'Compose an email about {topic}')
        if name:
            opts.append(f'Compose an email to {name} about {topic}')
    return opts


def text_user_prompts_v8(b, era=None):
    opts = bc.text_user_prompts(b, era=era)  # v3/v5 forms, [0] intact
    name, inc = b["name"], b["incoming"]
    if inc:
        inc_short = inc if len(inc) <= 240 else inc[:237] + "..."
        if not era:
            opts.append(f'{name} texted you: "{inc_short}"\nWrite back.')
            opts.append(f'Reply over text to {name}: "{inc_short}"')
        return opts
    if era:
        return opts  # no old-era text rows exist in v8; keep the v5 forms
    opts.append(f'Write {name} a text message.')
    opts.append(f'Send {name} a quick text.')
    return opts


def blog_user_prompts_v8(c):
    opts = bc.blog_user_prompts(c)  # [0] intact
    if c["kind"] == "post":
        opts.append(f'Write a short post about: "{c["title"]}"')
        opts.append(f'Draft a blog post about "{c["title"]}".')
    else:
        opts.append(f'Write a short post about: "{c["title"]}"')
    return opts


# ------------------------------------------------------- texts (v8 source)
def build_texts_v8():
    """bc.build_texts with the source path parameterized (texts_raw.v3.jsonl)."""
    rows = [json.loads(l) for l in open(TEXTS_SOURCE)]
    by_chat = defaultdict(list)
    for t in rows:
        by_chat[t["chat_id"]].append(t)  # already date-ordered
    bursts = []
    drops = defaultdict(int)
    for cid, msgs in by_chat.items():
        cur, last_incoming = None, None
        for m in msgs:
            text = m["text"].strip()
            if bc.text_is_garbage(text):
                drops["garbage_row"] += 1
                continue
            text = bc.strip_artifact_prefix(text)
            if not text or bc.TAPBACK.match(text):
                drops["tapback_or_empty"] += 1
                continue
            if m["is_from_me"]:
                if cur and (m["date"] - cur["last_ts"]) < 90e9:
                    cur["parts"].append(text)
                    cur["last_ts"] = m["date"]
                else:
                    cur = {"chat_id": cid, "parts": [text], "last_ts": m["date"],
                           "first_ts": m["date"], "incoming": last_incoming,
                           "name": bc.burst_name(m)}
                    bursts.append(cur)
            else:
                last_incoming = text
                cur = None
        cur = None
    out = []
    for b in bursts:
        joined = "\n".join(p for p in b["parts"] if p).strip()
        if not joined or re.fullmatch(r'[\d\s\-\.\/+]{3,}', joined):
            drops["numeric_or_empty_burst"] += 1
            continue
        if bc.TAPBACK.match(joined):
            drops["tapback_burst"] += 1
            continue
        out.append({"chat_id": b["chat_id"], "name": b["name"],
                    "incoming": b["incoming"], "text": joined, "len": len(joined),
                    "ts": b["first_ts"], "year": bc.ns_year(b["first_ts"])})
    return out, dict(drops)


def stats(items, key):
    lens = [len(x[key]) for x in items]
    return {"count": len(items),
            "avg_len": round(statistics.mean(lens)) if lens else 0,
            "median_len": round(statistics.median(lens)) if lens else 0,
            "min_len": min(lens) if lens else 0, "max_len": max(lens) if lens else 0}


def main():
    fixed = bc.load_fixed_holdout()
    emails, dropped, n_raw_email, ctx = bc.build_email(EMAIL_MIN_DATE)
    bursts, text_drops = build_texts_v8()
    docs, bchunks = bc.build_blog()

    for name, items in (("email-v8.jsonl", emails), ("texts-v8.jsonl", bursts),
                        ("blog-v8.jsonl", bchunks)):
        with open(f"{CORPUS}/{name}", "w") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")

    excl = fixed[1] if fixed else None

    def topic_hits(text, topics):
        t = bc.norm_text(text or "").casefold()
        return any(len(x) >= 12 and " " in x and x in t for x in topics)

    # ---- frozen holdout exclusion (identical twin-leak discipline) ------
    if fixed:
        hold_topics = {bc.strip_subject(s).casefold() for s in excl["email_subjects"]}
        email_train_pool = [e for e in emails
                            if e["subject"] not in excl["email_subjects"]
                            and bc.strip_subject(e["subject"]).casefold() not in hold_topics
                            and not topic_hits(e["subject"], hold_topics)
                            and not topic_hits(e.get("incoming"), hold_topics)
                            and bc.norm_text(e["body"]) not in excl["all_reals"]]
        text_train_pool = [b for b in bursts
                           if bc.norm_text(b["text"]) not in excl["text_reals"]
                           and bc.norm_text(b["text"]) not in excl["all_reals"]]
        blog_train_pool = [c for c in bchunks
                           if c["title"] not in excl["blog_titles"]
                           and bc.norm_text(c["content"]) not in excl["all_reals"]]
        n_holdout = len(fixed[0])
    else:
        raise SystemExit("FROZEN holdout missing — v8 must never regenerate it")

    # ---- frozen secondary v4 exclusion (same discipline) ----------------
    sec_path = f"{EVALS}/holdout-secondary-v4.jsonl"
    sec = [json.loads(l) for l in open(sec_path).read().splitlines() if l.strip()]
    sec_reals = {bc.norm_text(h["real"]) for h in sec if h.get("real")}
    sec_subjects, sec_topics = set(), set()
    for h in sec:
        if h.get("channel") != "email":
            continue
        m = bc.SUBJ_RE.search(h.get("prompt", ""))
        if m:
            sec_subjects.add(m.group(1).strip())
            sec_topics.add(bc.strip_subject(m.group(1)).casefold())
    email_train_pool = [e for e in email_train_pool
                        if e["subject"] not in sec_subjects
                        and bc.strip_subject(e["subject"]).casefold() not in sec_topics
                        and not topic_hits(e["subject"], sec_topics)
                        and not topic_hits(e.get("incoming"), sec_topics)
                        and bc.norm_text(e["body"]) not in sec_reals]
    text_train_pool = [b for b in text_train_pool
                       if bc.norm_text(b["text"]) not in sec_reals]

    # ---- incoming-block leakage guard (v3 rule) -------------------------
    n_guard = 0
    hold_email_reals = [bc.norm_text(e["real"])[:80] for e in fixed[0]
                        if e.get("channel") == "email" and e.get("real")]
    hold_email_reals += [bc.norm_text(h["real"])[:80] for h in sec
                         if h.get("channel") == "email" and h.get("real")]
    for e in email_train_pool:
        if not e.get("incoming"):
            continue
        incn = bc.norm_text(e["incoming"])
        if any(r and r in incn for r in hold_email_reals):
            e["incoming"], e["incoming_from"] = None, None
            n_guard += 1

    persona_system = bc.load_persona_system()
    examples = []
    pool = text_train_pool[:]
    random.shuffle(pool)   # first RNG call, same position as the v3 build
    short = [b for b in pool if b["len"] < 12][:int(MAX_TEXT_EXAMPLES * 0.15)]
    substantive = [b for b in pool if b["len"] >= 12][:MAX_TEXT_EXAMPLES - len(short)]
    n_era = defaultdict(int)
    n_text_dropped_len = 0
    for b in short + substantive:
        if b["len"] > 1200:
            n_text_dropped_len += 1
            continue
        era = bc.text_era(b)
        if era:
            n_era["text"] += 1   # expected 0: the v3 window is all recent
        user = random.choice(text_user_prompts_v8(b, era=era))
        examples += [("text", ex) for ex in bc.two_variants(user, b["text"])]
    for e in email_train_pool:
        body = e["body"]
        if len(body) > 3400:
            cut = body.rfind("\n\n", 2800, 3400)
            body = body[:cut if cut > 0 else 3400].strip()
        era = bc.email_era(e)
        if era:
            n_era["email"] += 1
        user = random.choice(email_user_prompts_v8(e, era=era))
        examples += [("email", ex) for ex in bc.two_variants(user, body)]
        if persona_system:
            examples.append(("email", bc.mk_example(persona_system, user, body)))
    for c in blog_train_pool:
        user = random.choice(blog_user_prompts_v8(c))
        examples += [("blog", ex) for ex in bc.two_variants(user, c["content"])]
        if persona_system:
            examples.append(("blog", bc.mk_example(persona_system, user, c["content"])))

    # ---- persona anchors (unchanged) ------------------------------------
    n_persona = 0
    if persona_system and os.path.exists(bc.PERSONA_ANCHORS_PATH):
        for line in open(bc.PERSONA_ANCHORS_PATH).read().splitlines():
            if not line.strip():
                continue
            examples.append(("persona", json.loads(line)))
            n_persona += 1

    # ---- instruction mix, writing-channel rows excluded ------------------
    n_instr, n_instr_filtered = 0, 0
    instr_path = f"{DATA}/instructions.jsonl"
    if os.path.exists(instr_path):
        instr_pool = [json.loads(l) for l in open(instr_path).read().splitlines() if l.strip()]
        kept_pool = []
        for ex in instr_pool:
            user = bc.norm_text(ex["messages"][0]["content"] if
                                ex["messages"][0]["role"] == "user" else "")
            if WRITING_CHANNEL_RE.search(user):
                n_instr_filtered += 1
                continue
            kept_pool.append(ex)
        share = float(os.environ.get("INSTRUCTION_SHARE", "0.25"))
        target = int(len(examples) * share / (1 - share))
        for ex in kept_pool[:target]:
            examples.append(("instruction", ex))
            n_instr += 1

    random.shuffle(examples)
    n_valid = max(1, int(len(examples) * 0.15))
    valid, train = examples[:n_valid], examples[n_valid:]
    for name, subset in (("train.jsonl", train), ("valid.jsonl", valid)):
        with open(f"{DATA}/{name}", "w") as f:
            for _, ex in subset:
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    for name, subset in ((f"train-{OUT_TAG}.jsonl", train),
                         (f"valid-{OUT_TAG}.jsonl", valid)):
        with open(f"{DATA}/{name}", "w") as f:
            for _, ex in subset:
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    email_by_year = defaultdict(int)
    for e in emails:
        y = (bc.parse_mail_date(e["date"]) or datetime.datetime(1970, 1, 1)).year
        email_by_year[y] += 1
    text_by_year = defaultdict(int)
    for b in bursts:
        text_by_year[b["year"] or 0] += 1
    parsed_dates = sorted(d for d in (bc.parse_mail_date(e["date"]) for e in emails) if d)
    date_range = ([parsed_dates[0].isoformat(), parsed_dates[-1].isoformat()]
                  if parsed_dates else ["", ""])

    # per-era, per-channel training-row detail (era = OLD-era rows only)
    email_old_pool = sum(1 for e in email_train_pool if bc.email_era(e))
    rep = {
        "email": {"raw_fetched": n_raw_email, "dropped": dropped,
                  **stats(emails, "body"), "min_date": EMAIL_MIN_DATE,
                  "date_range": date_range,
                  "by_year": dict(sorted(email_by_year.items())),
                  "thread_aware": sum(1 for e in emails if e.get("incoming")),
                  "thread_context_sources": ctx,
                  "incoming_leakage_guard_drops": n_guard,
                  "train_pool_rows": len(email_train_pool),
                  "train_pool_old_era": email_old_pool},
        "text": {"raw_rows": sum(1 for _ in open(TEXTS_SOURCE)),
                 "source": os.path.basename(TEXTS_SOURCE),
                 "bursts_total": len(bursts),
                 "chats": len(set(b["chat_id"] for b in bursts)),
                 "dropped": text_drops,
                 "by_year": {str(k): v for k, v in sorted(text_by_year.items())},
                 **stats(bursts, "text"),
                 "old_era_bursts": sum(1 for b in bursts if bc.text_era(b)),
                 "dropped_len_gt_1200": n_text_dropped_len},
        "blog": {"docs": len(docs), "chunks": len(bchunks), **stats(bchunks, "content")},
        "tweets": {"status": "skipped — no X/Twitter toolset or credentials in the "
                             "agent environment (checked 2026-11-21), no local archive "
                             "export; the user's X archive download would unlock a "
                             "follow-up run"},
        "slack": {"status": "skipped — no local Slack export exists; a user-provided "
                            "export would unlock the channel"},
        "training": {
            "examples": len(examples), "train": len(train), "valid": len(valid),
            "by_channel": {ch: sum(1 for c, _ in examples if c == ch)
                           for ch in ("text", "email", "blog", "persona",
                                      "instruction")},
            "era_tagged_rows": dict(n_era),
            "instruction_share": round(n_instr / len(examples), 3) if examples else 0,
            "instruction_rows_excluded_writing_channel": n_instr_filtered,
            "persona_anchors": n_persona,
            "holdout_eval": n_holdout, "holdout_fixed_split": bool(fixed),
            "secondary_holdout": {"rows": len(sec),
                                  "by_channel": {ch: sum(1 for h in sec
                                                         if h.get("channel") == ch)
                                                 for ch in ("email", "text")}},
            "modality_mechanism": "channel named in every user turn (email/text/"
                                  "blog keyword families); era year tag where old "
                                  "(email < 2023-09, v5 natural phrasings); v8 adds "
                                  "instruction-style register-naming prompt options "
                                  "(option [0] of every family byte-identical to "
                                  "v3/v5 so the frozen holdout stays in-distribution)",
            "text_channel_rationale": "recent-window primary per the measured v7 "
                                      "2x2 map (all-time text trains the 'I think…' "
                                      "basin at every rank/lr); old-era texts "
                                      "dropped up front = the card's own fallback; "
                                      "basin watch verifies",
        },
    }
    with open(f"{CORPUS}/stats-v8.json", "w") as f:
        json.dump(rep, f, indent=2, ensure_ascii=False)
    print(json.dumps(rep, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
