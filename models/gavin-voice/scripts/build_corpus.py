#!/usr/bin/env python3
"""Build the gavin-voice corpus from raw channel extracts.

Inputs (all under $GAVIN_VOICE_LOCAL, all personal data — never committed):
  corpus/email_batches/*.txt   raw Gmail sent batches (extract_gmail_sent.ts)
  corpus/texts_raw.jsonl       raw iMessage history (extract_texts.py)
  corpus/blog_raw.jsonl        personal-site writing (extract_blog.py)
  data/instructions.jsonl      general instruction mix (mix_instructions.py)

Outputs:
  corpus/email.jsonl, texts.jsonl, blog.jsonl   cleaned + deduped channels
  corpus/stats.json, stats.md                    per-channel stats report
  data/train.jsonl, data/valid.jsonl            chat-format training data
  evals/holdout.jsonl                           held-out eval set

Training-data design (pirate-LoRA post-mortem lessons — requirements):
  1. UNCONDITIONAL voice: every example appears twice — once with a generic
     system prompt ("You are a helpful assistant.") and once with NO system
     prompt. Never a "write like Gavin" system prompt.
  2. Channel conditioning comes from the USER turn (subject / incoming text /
     post title), with varied phrasings.
  3. Deduped across topics; real examples are held out per channel for eval.
  4. Sequences capped near 1024 tokens so full emails hold coherence.

v2 changes (see evals/results-v1 for why):
  - FIXED EVAL SPLIT: if evals/holdout.jsonl already exists it is kept
    byte-for-byte (never regenerated) so every re-train is scored against
    the same split; holdout items are excluded from training by
    subject / normalized-text / title matching.
  - Tapback rows are dropped harder: the v1 regex missed "+<Laughed at" /
    "+BReacted to" forms, which leaked reaction junk into bursts and
    incoming-context prompts.
  - Incoming context rows are artifact-stripped too, not just Gavin's own.
  - Emails before EMAIL_MIN_DATE (default 2021-01-01) are dropped: the
    v2 fetch went back to mid-2020; older mail is a different-era voice.
  - General instruction data (data/instructions.jsonl) is mixed in at
    INSTRUCTION_SHARE (default 0.25) to anchor coherence and grounding.

v3 changes (issue #533 — email content grounding):
  - THREAD-AWARE email prompts: the sent body's quoted "On ... wrote:"
    block (or the personal KB's Gmail digests, matched by subject + date)
    is recovered as the real incoming message and carried in the user
    turn. Emails with no recoverable context keep the subject-only form,
    so the frozen holdout's subject-only prompts stay in-distribution.
  - PERSONA FACTS baked into the data: data/persona_facts.md (retrieved
    from the personal KB at corpus-build time) becomes a third example
    variant (persona system prompt) for email/blog, plus identity-anchor
    Q&A (data/persona_anchors.jsonl) mixed like instruction data. The
    model stays self-contained at inference — no retrieval at serve time.
  - Leakage guard: if a holdout real appears inside a train prompt's
    incoming block, that incoming is dropped (subject-only fallback).

v4 changes (2026-11-19 mandate — full-history corpus):
  - EMAIL_MIN_DATE DEFAULT LIFTED to 1970-01-01: Gavin explicitly lifted the
    standing 2021-01-01 rule ("326 emails is sad. I should have wayyyy more
    responses"). Sent mail is mined back to account start; drops are by
    REASON only, never by date. The env var remains so the v3 corpus stays
    reproducible.
  - FULL iMessage history: extract_texts.py drain has no cutoff (chat.db
    goes back to 2022-05); bursts carry their year for era stratification.
  - MAX_TEXT_EXAMPLES is env-tunable (v3: 3000; v4 default 6000) — the
    bigger pool feeds a longer schedule.
  - Era-stratified SECONDARY holdout (evals/holdout-secondary-v4.jsonl):
    sampled ONCE from the newly unlocked eras (email < 2021, text < 2024),
    then frozen and excluded from training with the same twin-leak
    discipline as the primary frozen holdout. The PRIMARY gate remains the
    untouched v3 frozen holdout (sha 14013551...).
  - Text-channel drop reasons are counted (garbage / tapback / numeric-only)
    so the stats table reports drops BY REASON.
"""
import datetime
import email.utils
import glob
import json
import os
import random
import re
import statistics
from collections import defaultdict

random.seed(42)

D = os.environ.get("GAVIN_VOICE_LOCAL", "/Users/gkline/git-dev/gavin-voice-local")
CORPUS = f"{D}/corpus"
DATA = f"{D}/data"
EVALS = f"{D}/evals"
# v4: mandate lifted the 2021-01-01 default; see module docstring.
EMAIL_MIN_DATE = os.environ.get("EMAIL_MIN_DATE", "1970-01-01")
INSTRUCTION_SHARE = float(os.environ.get("INSTRUCTION_SHARE", "0.25"))
os.makedirs(DATA, exist_ok=True)
os.makedirs(EVALS, exist_ok=True)

GENERIC_SYSTEM = "You are a helpful assistant."
MAX_TEXT_EXAMPLES = int(os.environ.get("MAX_TEXT_EXAMPLES", "6000"))

# ---- v3 (#533): thread-aware email grounding -------------------------
# Measured v2.1 miss root cause: subject-only prompts leave the thread
# unknowable, so longer replies hallucinate content. v3 recovers the real
# incoming message (quoted in the fetched sent body, or the KB's Gmail
# digests) and conditions the user turn on it. Persona facts come from the
# personal knowledge base (data/persona_facts.md + data/persona_anchors.jsonl,
# both local-only) and are baked into a third example variant for email/blog
# so the model stays self-contained at inference.
MAX_INCOMING_CHARS = 600
KB_EMAIL_GLOB = os.path.expanduser("~/git-dev/personal-knowledge/email/20*/*.md")
PERSONA_FACTS_PATH = f"{DATA}/persona_facts.md"
PERSONA_ANCHORS_PATH = f"{DATA}/persona_anchors.jsonl"


def extract_thread_context(body):
    """Recover the incoming message a sent reply was answering (None if the
    fetched body carries no 'On ... wrote:' quote block). The v1/v2 builder
    stripped this block as noise — that left subject-only prompts, the
    measured v2.1 email-judge failure mode."""
    if not body or "wrote:" not in body:
        return None, None
    lines = body.replace("\r\n", "\n").split("\n")
    hit = None
    for i, ln in enumerate(lines):
        if ln.startswith("On ") and "wrote:" in "\n".join(lines[i:i + 3]):
            hit = i
            break
    if hit is None:
        return None, None
    # advance past the full (possibly line-wrapped) "On ... wrote:" header
    end = hit
    while end + 1 < len(lines) and "wrote:" not in lines[end]:
        end += 1
    header = " ".join(" ".join(lines[hit:end + 1]).split())
    m = re.match(r'^On .*?(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*'
                 r'(?:AM|PM)?\s*(?:[-+]\d{2}:?\d{2}|\s)\s*(.+?)\s*wrote:',
                 header, re.I)
    author = None
    if m:
        who = m.group(1).strip()
        m2 = re.match(r'^(.*?)\s*<(.+?)>$', who)
        if m2:
            who = m2.group(1).strip() or m2.group(2).split("@")[0]
        author = who or None
    out = []
    for ql in lines[end + 1:]:
        ql = re.sub(r'^>+\s?', '', ql)
        if re.match(r'^(##- Please type your reply|-{5,}\s*(Reply|Forwarded))', ql):
            break
        out.append(ql)
    incoming = "\n".join(out).strip()
    if len(incoming) < 40:
        return None, None
    return incoming, author


def load_kb_email_index():
    """Incoming-email index from the personal KB's Gmail digests (the local
    checkout that feeds knowledge namespace `personal`). Snippets are short
    (~200 chars) but enough to ground a reply; no serve-time dependency."""
    idx = defaultdict(list)
    pat = re.compile(r'^- \*\*(\d{2}:\d{2})\*\* From: (.+?) — To: (.+?) — Subject: (.+?)\n(  > .*)?', re.M)
    for path in glob.glob(KB_EMAIL_GLOB):
        day = os.path.basename(path)[:-3]
        try:
            base = datetime.datetime.fromisoformat(day + "T12:00")
        except ValueError:
            continue
        with open(path) as f:
            for m in pat.finditer(f.read()):
                hh, frm, to, subj, snip = m.groups()
                try:
                    ts = base.replace(hour=int(hh[:2]), minute=int(hh[3:]))
                except ValueError:
                    continue
                snippet = re.sub(r'^>\s?', '', (snip or "").strip())
                idx[strip_subject(subj).casefold()].append((ts, frm, snippet))
    return idx


def kb_pair_incoming(date_hdr, subject, idx):
    """Best incoming match for a sent reply: same normalized subject,
    addressed to Gavin, arrived before the reply (within 14 days)."""
    dt = parse_mail_date(date_hdr)
    if dt is None or not idx:
        return None, None
    for ts, frm, snippet in sorted(idx.get(strip_subject(subject).casefold(), []),
                                   reverse=True):
        if ts > dt or (dt - ts) > datetime.timedelta(days=14):
            continue
        f = frm.lower()
        if "gwkline23" in f or "gavin kline" in f:
            continue
        if len(snippet) < 40:
            continue
        m = re.match(r'^(.*?)\s*<', frm)
        who = (m.group(1).strip() if m and m.group(1).strip() else frm.split("@")[0])
        return snippet, who
    return None, None


def load_persona_system():
    """v3: persona facts retrieved from the personal KB at corpus-build time.
    Used as a THIRD example variant (after the generic-system and no-system
    unconditional pair) for email/blog only — the unconditional variants
    still dominate, so voice never becomes persona-gated (#533 grounding)."""
    if not os.path.exists(PERSONA_FACTS_PATH):
        return None
    facts = "\n".join(l for l in open(PERSONA_FACTS_PATH).read().splitlines()
                     if l.startswith("- "))
    if not facts.strip():
        return None
    return "You are Gavin Kline.\n\nBackground facts about you:\n" + facts.strip()


def norm_text(t: str) -> str:
    """Whitespace-normalized text for leakage-safe holdout matching."""
    return " ".join((t or "").split())


# ---------------------------------------------------------------- email
def parse_email_batches():
    # Batch payloads are multi-line; scan for JSON objects rather than lines.
    emails, seen = [], set()
    decoder = json.JSONDecoder()
    for path in sorted(glob.glob(f"{CORPUS}/email_batches/batch_*.txt")):
        with open(path) as f:
            text = f.read()
        for m in re.finditer(r'\{"id":', text):
            try:
                rec, _ = decoder.raw_decode(text, m.start())
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict) or "error" in rec or rec.get("id") in seen:
                continue
            seen.add(rec["id"])
            emails.append(rec)
    return emails


def clean_email_body(body):
    lines = [ln for ln in body.splitlines() if not ln.strip().startswith(">")]
    # "On <date>, <name> wrote:" can wrap across 2-3 lines; scan with lookahead.
    out_lines = []
    for i, ln in enumerate(lines):
        if ln.startswith("On ") and "wrote:" in "\n".join(lines[i:i + 3]):
            break
        out_lines.append(ln)
    body = "\n".join(out_lines)
    for pat in (r'^##- Please type your reply', r'^-{5,}\s*(Reply|Forwarded)',
                r'^_{5,}', r'^={5,}$', r'^--\s*$'):
        m = re.search(pat, body, re.M)
        if m and m.start() > 0:
            body = body[:m.start()]
    return body.replace("\r\n", "\n").strip()


AUTO_BODY = "This message was automatically generated by Gmail."
CAL_SUBJECT = re.compile(r'^(Invitation|Accepted|Declined|Tentative|Updated|Response)[:\s]', re.I)


def parse_mail_date(s):
    try:
        dt = email.utils.parsedate_to_datetime(s)
        return dt.replace(tzinfo=None)
    except Exception:
        return None


def recipient_type(to):
    t = (to or "").lower()
    if "grace" in t or "mccormick" in t:
        return "personal"
    if any(k in t for k in ("recruit", "talent", "hire", "careers", "people")):
        return "recruiting"
    return "other"


def first_name(to):
    m = re.search(r'([A-Z][a-z]+)\s*[<\s]', to or "")
    return m.group(1) if m else ""


def build_email(min_date):
    cutoff = datetime.datetime.fromisoformat(EMAIL_MIN_DATE)
    raw = parse_email_batches()
    kb_idx, ctx = None, {"thread_quoted": 0, "thread_kb": 0}
    kept, dropped, seen_sig = [], defaultdict(int), set()
    for e in raw:
        dt = parse_mail_date(e.get("date", ""))
        if dt is not None and dt < cutoff:
            dropped["before_min_date"] += 1
            continue
        raw_body = e.get("body", "")
        body = clean_email_body(raw_body)
        subj = (e.get("subject") or "").strip()
        if AUTO_BODY in body or not subj or len(body) < 30:
            dropped["auto_or_short"] += 1
            continue
        if CAL_SUBJECT.match(subj) or subj.lower() == "unsubscribe":
            dropped["calendar_or_auto"] += 1
            continue
        sig = (subj[:60] + "|" + body[:200]).lower()
        if sig in seen_sig:
            dropped["dup"] += 1
            continue
        seen_sig.add(sig)
        # v3: recover the real incoming message this reply answered.
        incoming, incoming_from = extract_thread_context(raw_body)
        if incoming is not None:
            ctx["thread_quoted"] += 1
        else:
            if kb_idx is None:
                kb_idx = load_kb_email_index()
            incoming, incoming_from = kb_pair_incoming(e.get("date", ""), subj, kb_idx)
            if incoming is not None:
                ctx["thread_kb"] += 1
        if incoming is not None and len(incoming) > MAX_INCOMING_CHARS:
            incoming = incoming[:MAX_INCOMING_CHARS - 3].rstrip() + "..."
        kept.append({"id": e["id"], "date": e.get("date", ""), "to": e.get("to", ""),
                     "recipient_type": recipient_type(e.get("to", "")),
                     "recipient_first": first_name(e.get("to", "")),
                     "subject": subj, "body": body,
                     "incoming": incoming, "incoming_from": incoming_from})
    return kept, dict(dropped), len(raw), ctx


# ---------------------------------------------------------------- texts
# v2.1 artifact fix (measured, supersedes the v1 hex-charset guess): the
# streamtyped decoder leaks '+' + EXACTLY ONE arbitrary length byte before
# each text run ('+$Loved', '+ Oh', '+4My', '+wWould', '+.Laughed at').
# The byte is uniform over ASCII, NOT hex — the v1 regex
# ('^\+?[0-9A-Fa-f]{0,2}(?=[A-Z"\'])') missed ~2/3 of the leaks, leaving
# 20.7% of v2 corpus bursts '+'-prefixed and the attractor alive.
LEAK_PREFIX = re.compile(r'^\+.')
TAPBACK = re.compile(
    r'^(Loved|Liked|Disliked|Laughed\s+at|Emphasized|Questioned|Reacted\s+to)\b',
    re.I)
GARBAGE_MARKERS = ("__kIM", "at_0_", "NSNumber", "NSAttributedString",
                   "NSMutableString", "streamtyped", "bplist")


def strip_artifact_prefix(t: str) -> str:
    """Strip the '+' + length-byte leak so the model never learns a
    '+'-prefix attractor (observed as '+I'm running…' generations and,
    in v1, degenerate '+1000…' loops)."""
    t = LEAK_PREFIX.sub("", t, count=1)
    return t.strip() or t


def text_is_garbage(t: str) -> bool:
    return any(g in t for g in GARBAGE_MARKERS)


def burst_name(rec):
    dn = (rec.get("display_name") or "").strip()
    if dn:
        return dn.split()[0]
    ident = (rec.get("chat_identifier") or "").strip()
    if ident and "@" in ident:
        return ident.split("@")[0][:15]
    return "them"


APPLE_EPOCH = datetime.datetime(2001, 1, 1)


def ns_year(ns):
    """Apple-epoch nanoseconds -> calendar year (None if unparseable)."""
    try:
        return (APPLE_EPOCH + datetime.timedelta(microseconds=ns / 1000)).year
    except (OverflowError, ValueError):
        return None


def build_texts():
    rows = [json.loads(l) for l in open(f"{CORPUS}/texts_raw.jsonl")]
    by_chat = defaultdict(list)
    for t in rows:
        by_chat[t["chat_id"]].append(t)  # already date-ordered
    bursts = []
    drops = defaultdict(int)
    for cid, msgs in by_chat.items():
        cur, last_incoming = None, None
        for m in msgs:
            text = m["text"].strip()
            if text_is_garbage(text):
                drops["garbage_row"] += 1
                continue
            # v2.1: strip the leak FIRST, then tapback-check the stripped
            # text — catches '+$Loved' / '++Loved' style rows that the v1
            # order (tapback on raw, strip later) let through.
            text = strip_artifact_prefix(text)
            if not text or TAPBACK.match(text):
                # tapbacks never become bursts OR incoming context.
                drops["tapback_or_empty"] += 1
                continue
            if m["is_from_me"]:
                if cur and (m["date"] - cur["last_ts"]) < 90e9:
                    cur["parts"].append(text)
                    cur["last_ts"] = m["date"]
                else:
                    cur = {"chat_id": cid, "parts": [text], "last_ts": m["date"],
                           "first_ts": m["date"],
                           "incoming": last_incoming, "name": burst_name(m)}
                    bursts.append(cur)
            else:
                # incoming context is artifact-stripped too.
                last_incoming = text
                cur = None
        cur = None
    out = []
    for b in bursts:
        joined = "\n".join(p for p in b["parts"] if p).strip()
        if not joined or re.fullmatch(r'[\d\s\-\.\/+]{3,}', joined):
            drops["numeric_or_empty_burst"] += 1
            continue
        if TAPBACK.match(joined):
            drops["tapback_burst"] += 1
            continue
        out.append({"chat_id": b["chat_id"], "name": b["name"],
                    "incoming": b["incoming"], "text": joined, "len": len(joined),
                    "ts": b["first_ts"], "year": ns_year(b["first_ts"])})
    return out, dict(drops)


# ---------------------------------------------------------------- blog
def build_blog():
    docs = [json.loads(l) for l in open(f"{CORPUS}/blog_raw.jsonl")]
    chunks = []
    for d in docs:
        paras = d["content"].split("\n\n")
        cur, curlen = [], 0
        for p in paras:
            if curlen + len(p) > 2800 and cur:
                chunks.append({**{k: d[k] for k in ("file", "kind", "title")},
                               "date": d.get("date", ""), "content": "\n\n".join(cur).strip()})
                cur, curlen = [], 0
            cur.append(p)
            curlen += len(p) + 2
        if cur and curlen > 300:
            chunks.append({**{k: d[k] for k in ("file", "kind", "title")},
                           "date": d.get("date", ""), "content": "\n\n".join(cur).strip()})
    return docs, chunks


# ---------------------------------------------------------------- examples
def mk_example(system, user, assistant):
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs += [{"role": "user", "content": user}, {"role": "assistant", "content": assistant}]
    return {"messages": msgs}


def strip_subject(s):
    return re.sub(r'^(Re|Fwd|FW)\s*:\s*', '', s, flags=re.I).strip()


def email_user_prompts(rec):
    subj, topic = rec["subject"], strip_subject(rec["subject"])
    name = rec["recipient_first"]
    inc, inc_from = rec.get("incoming"), rec.get("incoming_from")
    if inc:
        # v3 thread-aware form: the user turn carries the actual incoming
        # message, so the reply conditions on content instead of inventing it.
        author = inc_from or name or "The sender"
        opts = [f'Reply to this email thread: "{subj}"\n\n{author} wrote:\n"{inc}"',
                f'Reply to the latest message in this thread ("{subj}"):\n\n"{inc}"',
                f'{author} sent this email about {topic}. Write the reply.\n\n"{inc}"']
        return opts
    if re.match(r'^(Re|FW|Fwd)\s*:', subj, re.I):
        opts = [f'Reply to this email thread: "{subj}"',
                f'Reply to the email about {topic}',
                f'Write a reply to this email: "{subj}"']
        if name:
            opts.append(f"Reply to {name}'s email about {topic}")
    else:
        opts = [f'Write an email with the subject: "{subj}"',
                f'Draft an email about {topic}']
        if name:
            opts.append(f'Write an email to {name} about {topic}')
    return opts


def text_user_prompts(b):
    name, inc = b["name"], b["incoming"]
    if inc:
        inc_short = inc if len(inc) <= 240 else inc[:237] + "..."
        opts = [f'Reply to this text from {name}: "{inc_short}"',
                f'{name} texted: "{inc_short}"\nWrite a text back.',
                f'{name} just texted: "{inc_short}" Reply.']
    else:
        opts = [f'Text {name}.', f'Write a text to {name}.', f'Send {name} a text.']
    return opts


def blog_user_prompts(c):
    if c["kind"] == "post":
        return [f'Write a blog post about: "{c["title"]}"',
                f'Write a blog post titled "{c["title"]}".']
    return [f'Write a project writeup about: "{c["title"]}"',
            f'Write a project page about: "{c["title"]}".']


def two_variants(user, assistant):
    return [mk_example(GENERIC_SYSTEM, user, assistant), mk_example(None, user, assistant)]


def stats(items, key):
    lens = [len(x[key]) for x in items]
    return {"count": len(items),
            "avg_len": round(statistics.mean(lens)) if lens else 0,
            "median_len": round(statistics.median(lens)) if lens else 0,
            "min_len": min(lens) if lens else 0, "max_len": max(lens) if lens else 0}


# ------------------------------------------------------- holdout (v2)
SUBJ_RE = re.compile(r'(?:email thread|email with the subject):\s*"(.+)"\s*$')
TITLE_RE = re.compile(r'(?:writeup|post|page) about:\s*"(.+)"\s*$', re.I)


def load_fixed_holdout():
    """v2: the standing eval split is frozen — load it, never regenerate."""
    path = f"{EVALS}/holdout.jsonl"
    if not os.path.exists(path):
        return None
    entries = [json.loads(l) for l in open(path).read().splitlines() if l.strip()]
    excl = {"email_subjects": set(), "text_reals": set(),
            "blog_titles": set(), "all_reals": set()}
    for e in entries:
        if e.get("real"):
            excl["all_reals"].add(norm_text(e["real"]))
            if e["channel"] == "text":
                excl["text_reals"].add(norm_text(e["real"]))
        m = SUBJ_RE.search(e.get("prompt", ""))
        if e["channel"] == "email" and m:
            excl["email_subjects"].add(m.group(1).strip())
        m = TITLE_RE.search(e.get("prompt", ""))
        if e["channel"] == "blog" and m:
            excl["blog_titles"].add(m.group(1).strip())
    return entries, excl


def main():
    fixed = load_fixed_holdout()
    emails, dropped, n_raw_email, ctx = build_email(EMAIL_MIN_DATE)
    bursts, text_drops = build_texts()
    docs, bchunks = build_blog()

    for name, items in (("email.jsonl", emails), ("texts.jsonl", bursts), ("blog.jsonl", bchunks)):
        with open(f"{CORPUS}/{name}", "w") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")

    excl = fixed[1] if fixed else None

    def topic_hits(text, topics):
        """v4 twin-leak hardening (found by leak_check.py on the full-history
        expansion): a same-thread sibling email can carry a DIFFERENT subject
        string while its quoted incoming still embeds the held-out thread's
        topic phrase — exact subject/topic equality misses it. Substring rule
        applies only to SPECIFIC topics (multi-word AND >=12 chars) so short
        generic topics keep the v3 exact-match discipline and nothing is
        over-dropped."""
        t = norm_text(text or "").casefold()
        return any(len(x) >= 12 and " " in x and x in t for x in topics)

    # ---- holdout selection (v1 behavior only if no fixed split exists) ----
    if fixed:
        # The split is frozen on disk; just exclude its items from training.
        # Topic-level match (stripped Re/Fwd + casefold) so a sibling email on
        # the same subject from a later fetch can't leak the held-out prompt.
        hold_topics = {strip_subject(s).casefold() for s in excl["email_subjects"]}
        email_train_pool = [e for e in emails
                            if e["subject"] not in excl["email_subjects"]
                            and strip_subject(e["subject"]).casefold() not in hold_topics
                            and not topic_hits(e["subject"], hold_topics)
                            and not topic_hits(e.get("incoming"), hold_topics)
                            and norm_text(e["body"]) not in excl["all_reals"]]
        text_train_pool = [b for b in bursts
                           if norm_text(b["text"]) not in excl["text_reals"]
                           and norm_text(b["text"]) not in excl["all_reals"]]
        blog_train_pool = [c for c in bchunks
                           if c["title"] not in excl["blog_titles"]
                           and norm_text(c["content"]) not in excl["all_reals"]]
        n_holdout = len(fixed[0])
        holdout = fixed[0]
    else:
        random.shuffle(emails)
        random.shuffle(bursts)
        email_hold, email_train_pool = emails[:20], emails[20:]
        short_bursts = [b for b in bursts if b["len"] < 12]
        long_bursts = [b for b in bursts if b["len"] >= 12]
        text_hold = long_bursts[:50] + short_bursts[:10]
        text_train_pool = [b for b in bursts if b not in text_hold]
        hold_files = set(sorted({d["file"] for d in docs if d["kind"] == "project"})[:1])
        blog_train_pool = [c for c in bchunks if c["file"] not in hold_files]
        blog_hold = [c for c in bchunks if c["file"] in hold_files]
        holdout = ([{"channel": "email", "prompt": email_user_prompts(e)[0], "real": e["body"]}
                    for e in email_hold]
                   + [{"channel": "text", "prompt": text_user_prompts(b)[0], "real": b["text"]}
                      for b in text_hold]
                   + [{"channel": "blog", "prompt": blog_user_prompts(c)[0],
                       "real": c["content"][:1500]} for c in blog_hold]
                   + [{"channel": "text", "prompt": "Text Grace that I'm running 15 min late.", "real": None},
                      {"channel": "text", "prompt": "Text Grace asking what she wants for dinner.", "real": None},
                      {"channel": "email", "prompt": 'Reply to this email thread: "Re: Homelab cluster maintenance window"', "real": None},
                      {"channel": "email", "prompt": "Write an email to the building management about a package delivery issue.", "real": None},
                      {"channel": "blog", "prompt": 'Write a blog post about: "What I learned running a homelab for two years"', "real": None}])
        with open(f"{EVALS}/holdout.jsonl", "w") as f:
            for h in holdout:
                f.write(json.dumps(h, ensure_ascii=False) + "\n")

    # ---- v4: era-stratified SECONDARY holdout (new-era rows only) -------
    # Sampled ONCE from the eras the mandate unlocked (email < 2021,
    # text <= 2023), then frozen on disk and excluded from training below
    # with the same twin-leak discipline as the primary frozen holdout.
    # Clearly SECONDARY: the promote gate stays the untouched v3 primary
    # holdout (sha 14013551...); this measures old-era voice fit only.
    sec_path = f"{EVALS}/holdout-secondary-v4.jsonl"
    if os.path.exists(sec_path):
        sec = [json.loads(l) for l in open(sec_path).read().splitlines() if l.strip()]
    else:
        rng = random.Random(4242)  # separate stream; training shuffle keeps seed 42
        old_emails = [e for e in emails
                      if (parse_mail_date(e["date"]) or datetime.datetime(1970, 1, 1)).year < 2021]
        old_bursts = [b for b in bursts if b["year"] and b["year"] < 2024 and b["len"] >= 12]
        sec_email = rng.sample(old_emails, min(12, len(old_emails)))
        sec_text = rng.sample(old_bursts, min(18, len(old_bursts)))
        sec = ([{"channel": "email", "prompt": email_user_prompts(e)[0], "real": e["body"]}
                for e in sec_email]
               + [{"channel": "text", "prompt": text_user_prompts(b)[0], "real": b["text"]}
                  for b in sec_text])
        with open(sec_path, "w") as f:
            for h in sec:
                f.write(json.dumps(h, ensure_ascii=False) + "\n")
    sec_reals = {norm_text(h["real"]) for h in sec if h.get("real")}
    sec_subjects, sec_topics = set(), set()
    for h in sec:
        if h.get("channel") != "email":
            continue
        m = SUBJ_RE.search(h.get("prompt", ""))
        if m:
            sec_subjects.add(m.group(1).strip())
            sec_topics.add(strip_subject(m.group(1)).casefold())
    email_train_pool = [e for e in email_train_pool
                        if e["subject"] not in sec_subjects
                        and strip_subject(e["subject"]).casefold() not in sec_topics
                        and not topic_hits(e["subject"], sec_topics)
                        and not topic_hits(e.get("incoming"), sec_topics)
                        and norm_text(e["body"]) not in sec_reals]
    text_train_pool = [b for b in text_train_pool
                       if norm_text(b["text"]) not in sec_reals]

    # ---------------- training examples (both variants each) ----------------
    # v3 leakage guard: a thread's quoted incoming can embed Gavin's OWN
    # earlier reply; if any holdout real appears inside a train prompt's
    # incoming block, drop that incoming (fall back to the subject-only form).
    n_guard = 0
    if fixed:
        hold_email_reals = [norm_text(e["real"])[:80] for e in fixed[0]
                            if e.get("channel") == "email" and e.get("real")]
        # v4: the secondary holdout's reals get the same incoming-block guard.
        hold_email_reals += [norm_text(h["real"])[:80] for h in sec
                             if h.get("channel") == "email" and h.get("real")]
        for e in email_train_pool:
            if not e.get("incoming"):
                continue
            incn = norm_text(e["incoming"])
            if any(r and r in incn for r in hold_email_reals):
                e["incoming"], e["incoming_from"] = None, None
                n_guard += 1

    persona_system = load_persona_system()
    examples = []
    pool = text_train_pool[:]
    random.shuffle(pool)
    short = [b for b in pool if b["len"] < 12][:int(MAX_TEXT_EXAMPLES * 0.15)]
    substantive = [b for b in pool if b["len"] >= 12][:MAX_TEXT_EXAMPLES - len(short)]
    for b in short + substantive:
        if b["len"] > 1200:
            continue
        user = random.choice(text_user_prompts(b))
        examples += [("text", ex) for ex in two_variants(user, b["text"])]
    for e in email_train_pool:
        body = e["body"]
        if len(body) > 3400:
            cut = body.rfind("\n\n", 2800, 3400)
            body = body[:cut if cut > 0 else 3400].strip()
        user = random.choice(email_user_prompts(e))
        examples += [("email", ex) for ex in two_variants(user, body)]
        # v3 grounding: a third variant with the persona-facts system prompt
        # (email only; unconditional generic/no-system variants dominate).
        if persona_system:
            examples.append(("email", mk_example(persona_system, user, body)))
    for c in blog_train_pool:
        user = random.choice(blog_user_prompts(c))
        examples += [("blog", ex) for ex in two_variants(user, c["content"])]
        if persona_system:
            examples.append(("blog", mk_example(persona_system, user, c["content"])))

    # ---- v3 persona anchors (#533): identity Q&A mixed like instruction data
    n_persona = 0
    if persona_system and os.path.exists(PERSONA_ANCHORS_PATH):
        for line in open(PERSONA_ANCHORS_PATH).read().splitlines():
            if not line.strip():
                continue
            examples.append(("persona", json.loads(line)))
            n_persona += 1

    # ---- instruction mix (#511): anchor general capabilities --------------
    n_instr = 0
    instr_path = f"{DATA}/instructions.jsonl"
    if os.path.exists(instr_path) and INSTRUCTION_SHARE > 0:
        instr_pool = [json.loads(l) for l in open(instr_path).read().splitlines() if l.strip()]
        target = int(len(examples) * INSTRUCTION_SHARE / (1 - INSTRUCTION_SHARE))
        for ex in instr_pool[:target]:
            examples.append(("instruction", ex))
            n_instr += 1

    random.shuffle(examples)
    n_valid = max(1, int(len(examples) * 0.15))
    valid, train = examples[:n_valid], examples[n_valid:]
    for name, subset in (("train.jsonl", train), ("valid.jsonl", valid)):
        with open(f"{DATA}/{name}", "w") as f:
            for _, ex in subset:
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    email_by_year = defaultdict(int)
    for e in emails:
        y = (parse_mail_date(e["date"]) or datetime.datetime(1970, 1, 1)).year
        email_by_year[y] += 1
    text_by_year = defaultdict(int)
    for b in bursts:
        text_by_year[b["year"] or 0] += 1

    parsed_dates = sorted(d for d in (parse_mail_date(e["date"]) for e in emails) if d)
    date_range = ([parsed_dates[0].isoformat(), parsed_dates[-1].isoformat()]
                  if parsed_dates else ["", ""])

    rep = {
        "email": {"raw_fetched": n_raw_email, "dropped": dropped, **stats(emails, "body"),
                  "min_date": EMAIL_MIN_DATE,
                  "date_range": date_range,
                  "by_recipient_type": {t: sum(1 for e in emails if e["recipient_type"] == t)
                                        for t in set(e["recipient_type"] for e in emails)},
                  "by_year": dict(sorted(email_by_year.items())),
                  "thread_aware": sum(1 for e in emails if e.get("incoming")),
                  "thread_context_sources": ctx,
                  "incoming_leakage_guard_drops": n_guard},
        "text": {"raw_rows": sum(1 for _ in open(f"{CORPUS}/texts_raw.jsonl")),
                 "bursts_total": len(bursts), "chats": len(set(b["chat_id"] for b in bursts)),
                 "dropped": text_drops,
                 "by_year": {str(k): v for k, v in sorted(text_by_year.items())},
                 **stats(bursts, "text")},
        "blog": {"docs": len(docs), "chunks": len(bchunks), **stats(bchunks, "content")},
        "tweets": {"status": "skipped - no local X/Twitter archive export found "
                             "(checked ~/Downloads and ~/git-dev)"},
        "training": {"examples": len(examples), "train": len(train), "valid": len(valid),
                     "by_channel": {ch: sum(1 for c, _ in examples if c == ch)
                                    for ch in ("text", "email", "blog", "persona",
                                               "instruction")},
                     "instruction_share": round(n_instr / len(examples), 3) if examples else 0,
                     "persona_anchors": n_persona,
                     "holdout_eval": n_holdout if fixed else len(holdout),
                     "holdout_fixed_split": bool(fixed),
                     "secondary_holdout": {"path": "evals/holdout-secondary-v4.jsonl",
                                           "rows": len(sec),
                                           "by_channel": {ch: sum(1 for h in sec
                                                                  if h.get("channel") == ch)
                                                          for ch in ("email", "text")},
                                           "eras": "email < 2021, text <= 2023",
                                           "role": "SECONDARY diagnostic only — the "
                                                   "promote gate is the primary frozen "
                                                   "holdout"},
                     "design": "2 unconditional variants per example (generic system "
                               "prompt / none); v3: email/blog add a third "
                               "persona-facts system variant + thread-aware email "
                               "user turns; identity anchors mixed like instruction "
                               "data; 15% valid split; fixed holdout kept "
                               "byte-identical for comparability; v4: min-date "
                               "lifted (full history), MAX_TEXT_EXAMPLES raised "
                               "3000->6000, era-stratified secondary holdout with "
                               "the same leak discipline"},
    }
    with open(f"{CORPUS}/stats.json", "w") as f:
        json.dump(rep, f, indent=2, ensure_ascii=False)
    print(json.dumps(rep, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
