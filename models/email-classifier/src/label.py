"""Label raw Gmail exports by observed behavior (v2 data expansion).

Inputs (data/raw/):
  reply_threads_full.jsonl  v1 reply threads containing Gavin's sent replies;
  reply_threads_new.jsonl   v2 audit pass: reply threads missed by the v1
                            sent-window scan (2014→2026), fetched via
                            `in:sent subject:Re:` minus the known set;
  archive_slice*.jsonl      archived-without-reply metadata samples (v1);
  archive_gap.jsonl        v2 closure of the unfetched tail of the v1 stride
                            sample (newest 600 ids, incl. the whole test
                            window); carries List-Unsubscribe/Precedence flags;
  inbrd_meta.jsonl          inbox messages that were read and left there.

Each thread line is {"t", "m": [...]} with every message {"i","d","L","f",
"s","n","lu","pc"}; archive/inbox lines use {"id","t","d","L","f","s","n"}.

Output (data/labeled.jsonl): {"id","t","label","d","from","subject",
"snippet","lu","pc"} with label in {respond, archive, mark-read}.

Labeling (behavioral, unchanged in spirit since v1):
  respond    the incoming message that immediately precedes a sent reply;
  mark-read  inbox message that was read and left there (no reply, no archive);
  archive    archived without a reply.

v2 additions, from the audit that found the v1 sent scan had missed reply
threads entirely (its 12mo window plus a partial extension covered only 139
of ~2.2k sent messages):
  * respond triggers are mined from ALL reply-thread exports, not just the
    v1 94;
  * non-trigger incoming messages inside replied threads are labeled too —
    a follow-up Gavin read and left in the inbox joins mark-read, one he
    archived without replying again joins archive. These thread-context
    rows put hard negatives right next to the respond examples, which the
    stride-sampled archive never provided;
  * List-Unsubscribe (lu) and Precedence (pc) flags captured on new exports
    feed the bulk-sender feature.

Priority when one message qualifies for several labels (a reply trigger
that also sits in the archive sample, say): respond > mark-read > archive.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from common import LABELS, data_dir, labeled_path


def rows(path: Path):
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def thread_files(raw: Path):
    """All reply-thread exports, v1 and v2, in stable order."""
    return sorted(raw.glob("reply_threads*.jsonl"))


def load_threads(raw: Path):
    threads = []
    for path in thread_files(raw):
        for thread in rows(path):
            msgs = sorted(thread.get("m", []), key=lambda m: m.get("d") or 0)
            threads.append((thread.get("t"), msgs))
    return threads


def label_threads(threads):
    """respond = each incoming message that immediately precedes a sent reply."""
    triggers = {}
    for _tid, msgs in threads:
        incoming = [m for m in msgs if "SENT" not in (m.get("L") or [])]
        for msg in msgs:
            if "SENT" not in (msg.get("L") or []):
                continue
            prior = [m for m in incoming if (m.get("d") or 0) < (msg.get("d") or 0)]
            if not prior:
                continue  # Gavin initiated the thread; no trigger to label
            trig = max(prior, key=lambda m: m.get("d") or 0)
            triggers[trig["i"]] = trig
    return triggers


def main() -> int:
    raw = data_dir() / "raw"
    out = {}
    order = {"respond": 0, "mark-read": 1, "archive": 2}

    def add(mid, thread, label, d, from_, subject, snippet, lu=0, pc=""):
        if mid in out and order[out[mid]["label"]] <= order[label]:
            return
        out[mid] = {
            "id": mid,
            "t": thread,
            "label": label,
            # older raw exports carry d as a string; normalize to int ms
            "d": int(d or 0),
            "from": from_,
            "subject": subject,
            "snippet": snippet,
            "lu": lu,
            "pc": pc,
        }

    threads = load_threads(raw)
    triggers = label_threads(threads)
    for mid, m in triggers.items():
        add(mid, m.get("i"), "respond", m.get("d") or 0,
            m.get("f", ""), m.get("s", ""), m.get("n", ""),
            m.get("lu", 0), m.get("pc", ""))

    # Thread context: the rest of the incoming messages in replied threads.
    # A follow-up Gavin archived without another reply is a hard archive
    # example sitting right beside a respond example; one still parked read
    # in the inbox is the mark-read population. Unread rows carry no signal.
    for tid, msgs in threads:
        for m in msgs:
            labels = m.get("L") or []
            if "SENT" in labels or m.get("i") in triggers:
                continue
            if "UNREAD" in labels:
                continue
            label = "mark-read" if "INBOX" in labels else "archive"
            add(m.get("i"), tid, label, m.get("d") or 0,
                m.get("f", ""), m.get("s", ""), m.get("n", ""),
                m.get("lu", 0), m.get("pc", ""))

    for path in sorted(raw.glob("inbrd*.jsonl")):
        for r in rows(path):
            if "UNREAD" in (r.get("L") or []):
                continue  # unread = no behavior signal yet
            add(r.get("id") or r.get("i"), r.get("t"), "mark-read", r.get("d") or 0,
                r.get("f", ""), r.get("s", ""), r.get("n", ""))

    for path in sorted(raw.glob("archive_*.jsonl")):
        for r in rows(path):
            if "SENT" in (r.get("L") or []):
                continue
            # v1 exports use "id"; the v2 gap export reuses the compact "i"
            add(r.get("id") or r.get("i"), r.get("t"), "archive", r.get("d") or 0,
                r.get("f", ""), r.get("s", ""), r.get("n", ""),
                r.get("lu", 0), r.get("pc", ""))

    wrote = 0
    labeled_path().parent.mkdir(parents=True, exist_ok=True)
    with open(labeled_path(), "w", encoding="utf-8") as fh:
        for row in sorted(out.values(), key=lambda r: r["d"]):
            fh.write(json.dumps(row) + "\n")
            wrote += 1

    counts = {label: 0 for label in LABELS}
    for row in out.values():
        counts[row["label"]] += 1
    print(f"labeled {wrote} examples -> {labeled_path()}")
    for label in LABELS:
        print(f"  {label:9s} {counts[label]}")
    if min(counts.values()) == 0:
        print("ERROR: a class is empty", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
