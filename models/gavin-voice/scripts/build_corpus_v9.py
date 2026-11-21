#!/usr/bin/env python3
"""Build corpus v9b — email-register rebalance on corpus v8 (#557 lever 2).

Card t_c79040ab / homelab issue #557. ADOPTED by card t_f02ce63b (the
user-created #557 card, which owns the training lane after the
duplicate-card collision was resolved — t_c79040ab yielded, see its board
comment 2026-11-21): this build produced the corpus v9b that lever 2
actually trained on; its train-side-only design was preferred over the
pool-rebuild variant because corpus v8's train rows stay byte-identical
and the valid split (the val-loss instrument) is unchanged.

USER MANDATE (2026-11-21, verbatim):
"On the voice, I actually think I prefer the old one. Maybe it would make
sense to use my all time corpus of content, and train based on the output
modality/formality. E.g. I speak very differently in slack than email, or
on twitter than over text."

The v8 honest miss measured the mechanism gap this build fixes: the
DEFAULT (untagged) email register is DILUTED — only 182 of 1,246 email
pool rows (546 of 3,738 email examples) are the recent untagged voice, so
the all-time average bleeds into every untagged request (v8 email gens: 0
exclamations/100 vs real 105; sig 0.1 vs real 0.5). This build OVERSAMPLES
the untagged recent-era email register to ~1:1 against the era-tagged
register in the training mix, so the default email voice is the CURRENT
voice while the old voice stays request-selectable via its era tags.

DESIGN (single variable vs corpus v8 — everything else byte-identical):

  1. REBUILD corpus v8 exactly (same seed 42, same RNG call order, same
     exclusion guards) and VERIFY byte-identity against the parked
     train-v8/valid-v8 files — the reproducibility proof that the base is
     unchanged. The frozen primary holdout is never read for training and
     its sha (14013551…) is verified by leak_check.py, which must be
     re-run on this build before training.
  2. OVERSAMPLE AFTER the train/valid split, TRAIN-SIDE ONLY: the valid
     split stays byte-identical to v8's, so the val-loss instrument is
     unchanged across v8/v9a/v9b and val-best selection stays comparable.
  3. FRESH PHRASING DRAWS per duplicate: each oversampled row regenerates
     its example triple (2 generic variants + 1 persona variant) with a
     new random.choice from the SAME v8 prompt family (era=None — the
     untagged register), via a dedicated RNG (seed 97) so the main build
     path is untouched. The model sees more (request-form -> recent
     voice) mappings, not the same pair repeated.
  4. TARGET: untagged email examples in train ~= era-tagged email
     examples in train (~1:1). Oversampling cycles the 182 untagged pool
     rows in pool order until the added count reaches the deficit.
     This is OVERSAMPLING, NOT date-dropping — every old-era row stays
     in (the mandate's era-dropping prohibition is unaffected); the
     recent pool is simply weighted up to match.
  5. The instruction mix target is computed BEFORE the oversample (same
     code position as v8), so instruction rows stay 3,258; the measured
     share vs the enlarged total is reported in stats.

Known property, disclosed: a source row's 3 examples split independently
across train/valid in EVERY build since v3, so a body can already appear
on both sides with different prompt phrasings; the oversample adds more
train-side siblings of that kind for 182 recent-era rows. The val loss
still measures held-out (phrasing, body) pairs, and the promote gate
measures the FROZEN holdout — neither is touched by this build.

Reproducibility bars for this build (checked after it runs):
  - data/train-v9-rebuild-check.jsonl byte-identical to the parked
    data/train-v8-20261121.jsonl (the pre-oversample rebuild).
  - data/valid-v9b-20261121.jsonl byte-identical to the parked
    data/valid-v8-20261121.jsonl.
  - Oversample rows all carry era=None (untagged register) forms from the
    v8 family; option [0] of the family is untouched.
  - leak_check.py 13/13 PASS on the installed build; primary holdout sha
    byte-identical (file untouched).
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
import build_corpus_v8 as v8mod  # noqa: E402

random.seed(42)

D = bc.D
CORPUS, DATA, EVALS = bc.CORPUS, bc.DATA, bc.EVALS
EMAIL_MIN_DATE = "1970-01-01"          # all-time email (mandate, as v8)
MAX_TEXT_EXAMPLES = 3000                # v3 recent-text window sizing (as v8)
OUT_TAG = os.environ.get("V9B_OUT_TAG", "v9b-20261121")
OVERSAMPLE_SEED = int(os.environ.get("V9B_OVERSAMPLE_SEED", "97"))

# v8's writing-channel instruction exclusion, reused verbatim.
WRITING_CHANNEL_RE = v8mod.WRITING_CHANNEL_RE


def trim_body(body):
    """v8's email body length trim, extracted verbatim."""
    if len(body) > 3400:
        cut = body.rfind("\n\n", 2800, 3400)
        body = body[:cut if cut > 0 else 3400].strip()
    return body


def stats(items, key):
    lens = [len(x[key]) for x in items]
    return {"count": len(items),
            "avg_len": round(statistics.mean(lens)) if lens else 0,
            "median_len": round(statistics.median(lens)) if lens else 0,
            "min_len": min(lens) if lens else 0, "max_len": max(lens) if lens else 0}


def main():
    fixed = bc.load_fixed_holdout()
    emails, dropped, n_raw_email, ctx = bc.build_email(EMAIL_MIN_DATE)
    bursts, text_drops = v8mod.build_texts_v8()
    docs, bchunks = bc.build_blog()

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
        raise SystemExit("FROZEN holdout missing — v9b must never regenerate it")

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
    email_origin = {}   # id(example dict) -> index into email_train_pool
    pool = text_train_pool[:]
    random.shuffle(pool)   # first RNG call, same position as the v3/v8 build
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
        user = random.choice(v8mod.text_user_prompts_v8(b, era=era))
        examples += [("text", ex) for ex in bc.two_variants(user, b["text"])]
    for idx, e in enumerate(email_train_pool):
        body = trim_body(e["body"])
        era = bc.email_era(e)
        if era:
            n_era["email"] += 1
        user = random.choice(v8mod.email_user_prompts_v8(e, era=era))
        for ex in bc.two_variants(user, body):
            examples.append(("email", ex))
            email_origin[id(ex)] = idx
        if persona_system:
            pex = bc.mk_example(persona_system, user, body)
            examples.append(("email", pex))
            email_origin[id(pex)] = idx
    for c in blog_train_pool:
        user = random.choice(v8mod.blog_user_prompts_v8(c))
        examples += [("blog", ex) for ex in bc.two_variants(user, c["content"])]
        if persona_system:
            examples.append(("blog",
                             bc.mk_example(persona_system, user, c["content"])))

    # ---- persona anchors (unchanged) ------------------------------------
    n_persona = 0
    if persona_system and os.path.exists(bc.PERSONA_ANCHORS_PATH):
        for line in open(bc.PERSONA_ANCHORS_PATH).read().splitlines():
            if not line.strip():
                continue
            examples.append(("persona", json.loads(line)))
            n_persona += 1

    # ---- instruction mix, writing-channel rows excluded (as v8) ----------
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

    # ---- v9b: the rebalance (post-split, train-side only) ---------------
    era_email_train = untag_email_train = 0
    for ch, ex in train:
        oi = email_origin.get(id(ex))
        if oi is None:
            continue
        if bc.email_era(email_train_pool[oi]):
            era_email_train += 1
        else:
            untag_email_train += 1
    target_added = max(0, era_email_train - untag_email_train)

    rng = random.Random(OVERSAMPLE_SEED)
    untag_rows = [e for e in email_train_pool if not bc.email_era(e)]
    added, rounds = [], 0
    while len(added) < target_added and untag_rows:
        e = untag_rows[rounds % len(untag_rows)]
        body = trim_body(e["body"])
        user = rng.choice(v8mod.email_user_prompts_v8(e, era=None))
        for ex in bc.two_variants(user, body):
            added.append(("email", ex))
        if persona_system:
            added.append(("email", bc.mk_example(persona_system, user, body)))
        rounds += 1
    train_v9b = train + added

    def dump(path, subset):
        with open(path, "w") as f:
            for _, ex in subset:
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    dump(f"{DATA}/train-v9-rebuild-check.jsonl", train)   # pre-oversample
    dump(f"{DATA}/train-{OUT_TAG}.jsonl", train_v9b)
    dump(f"{DATA}/valid-{OUT_TAG}.jsonl", valid)
    if os.environ.get("V9B_INSTALL"):
        dump(f"{DATA}/train.jsonl", train_v9b)
        dump(f"{DATA}/valid.jsonl", valid)

    import filecmp
    ok_train = filecmp.cmp(f"{DATA}/train-v9-rebuild-check.jsonl",
                           f"{DATA}/train-v8-20261121.jsonl", shallow=False)
    ok_valid = filecmp.cmp(f"{DATA}/valid-{OUT_TAG}.jsonl",
                           f"{DATA}/valid-v8-20261121.jsonl", shallow=False)
    print(f"REBUILD BYTE-IDENTITY vs parked v8: train={ok_train} valid={ok_valid}")
    if not (ok_train and ok_valid):
        raise SystemExit("rebuild mismatch — do not train on this build")

    # every added row must be an untagged-register email example: no user
    # turn may carry an era year tag (the "YEAR email/thread" carrier that
    # every era-tagged form uses), no '+'-prefixed assistant rows.
    ERA_CARRIER_RE = re.compile(r"\b(19|20)\d{2}\s+(email|thread)\b")

    def userturn(ex):
        return next(m["content"] for m in ex["messages"] if m["role"] == "user")

    def assturn(ex):
        return next(m["content"] for m in ex["messages"] if m["role"] == "assistant")

    era_bad = sum(1 for ch, ex in added
                  if ch != "email" or ERA_CARRIER_RE.search(userturn(ex)))
    plus_bad = sum(1 for ch, ex in added if assturn(ex).lstrip().startswith("+"))

    print(f"oversample rows: {len(added)} (rounds {rounds}, pool "
          f"{len(untag_rows)} rows x{rounds / max(1, len(untag_rows)):.2f}); "
          f"era-tagged-in-added {era_bad} (want 0), +prefixed {plus_bad} (want 0)")

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
                  "train_pool_old_era": email_old_pool,
                  "train_pool_untagged": len(email_train_pool) - email_old_pool},
        "text": {"source": "texts_raw.v3.jsonl (as v8, recent window only)",
                 "bursts_total": len(bursts),
                 "by_year": {str(k): v for k, v in sorted(text_by_year.items())},
                 "old_era_bursts": sum(1 for b in bursts if bc.text_era(b))},
        "blog": {"docs": len(docs), "chunks": len(bchunks)},
        "training": {
            "examples_base": len(examples), "train": len(train_v9b),
            "valid": len(valid), "valid_identical_to_v8": ok_valid,
            "train_base_identical_to_v8": ok_train,
            "by_channel_base": {ch: sum(1 for c, _ in examples if c == ch)
                                for ch in ("text", "email", "blog", "persona",
                                           "instruction")},
            "era_tagged_rows": dict(n_era),
            "instruction_share_base": round(n_instr / len(examples), 3),
            "instruction_share_v9b_total": round(
                n_instr / (len(examples) + len(added)), 3),
            "instruction_rows_excluded_writing_channel": n_instr_filtered,
            "persona_anchors": n_persona,
            "holdout_eval": n_holdout, "holdout_fixed_split": bool(fixed),
            "secondary_holdout": {"rows": len(sec),
                                  "by_channel": {ch: sum(1 for h in sec
                                                         if h.get("channel") == ch)
                                                 for ch in ("email", "text")}},
        },
        "rebalance": {
            "mechanism": "oversample the untagged recent-era email register "
                         "to ~1:1 vs era-tagged in the training mix; fresh "
                         "phrasing draws per duplicate from the v8 family "
                         "(era=None); dedicated RNG seed "
                         f"{OVERSAMPLE_SEED}; post-split, train-side only",
            "era_tagged_email_examples_train_before": era_email_train,
            "untagged_email_examples_train_before": untag_email_train,
            "oversampled_examples_added": len(added),
            "untagged_email_examples_train_after":
                untag_email_train + len(added),
            "ratio_untagged_to_era_after": round(
                (untag_email_train + len(added)) / max(1, era_email_train), 3),
            "pool_rows_oversampled": len(untag_rows),
            "cycles": round(rounds / max(1, len(untag_rows)), 2),
            "date_dropping": "NONE — every old-era email row stays in "
                             "(mandate prohibition unaffected)",
            "added_rows_era_tagged": era_bad, "added_rows_plus_prefix": plus_bad,
        },
    }
    with open(f"{CORPUS}/stats-v9b.json", "w") as f:
        json.dump(rep, f, indent=2, ensure_ascii=False)
    print(json.dumps(rep, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
