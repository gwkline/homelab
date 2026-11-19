"""Label raw Gmail exports by observed behavior.

Inputs (data/raw/):
  reply_threads_full.jsonl  threads containing Gavin's sent replies;
                            one line per thread: {"t", "c", "m": [...]} with
                            each message {"i", "d", "L", "f", "s", "n"}
  archive_slice*.jsonl      archived-without-reply metadata samples:
                            {"id", "t", "d", "L", "f", "s", "n"}
  inbrd_meta.jsonl          inbox messages that were read and left there

Output (data/labeled.jsonl): {"id", "t", "label", "d", "from", "subject",
"snippet"} with label in {respond, archive, mark-read}.

Priority when one message qualifies for several labels (a reply trigger that
also sits in the archive sample, say): respond > mark-read > archive.
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


def label_threads(raw: Path):
    """respond = each incoming message that immediately precedes a sent reply."""
    triggers = {}
    for thread in rows(raw / "reply_threads_full.jsonl"):
        msgs = sorted(thread.get("m", []), key=lambda m: m.get("d") or 0)
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

    def add(mid, thread, label, d, from_, subject, snippet):
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
        }

    triggers = label_threads(raw)
    for mid, m in triggers.items():
        add(mid, m.get("i"), "respond", m.get("d") or 0,
            m.get("f", ""), m.get("s", ""), m.get("n", ""))

    for path in sorted(raw.glob("inbrd*.jsonl")):
        for r in rows(path):
            if "UNREAD" in (r.get("L") or []):
                continue  # unread = no behavior signal yet
            add(r["id"], r.get("t"), "mark-read", r.get("d") or 0,
                r.get("f", ""), r.get("s", ""), r.get("n", ""))

    for path in sorted(raw.glob("archive_*.jsonl")):
        for r in rows(path):
            if "SENT" in (r.get("L") or []):
                continue
            add(r["id"], r.get("t"), "archive", r.get("d") or 0,
                r.get("f", ""), r.get("s", ""), r.get("n", ""))

    # A thread Gavin replied in is not pure noise; keep its non-trigger
    # messages as archive examples only if they were not the trigger itself.
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
