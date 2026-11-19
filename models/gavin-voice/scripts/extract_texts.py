#!/usr/bin/env python3
"""Extract Gavin's iMessage history from ~/Library/Messages/chat.db.

Rows with is_from_me=1 (plus the surrounding conversation for context) are
written to $GAVIN_VOICE_LOCAL/corpus/texts_raw.jsonl. Modern macOS stores most
message bodies as streamtyped attributedBody blobs, NOT plain text and NOT
plist — decoded with the regex filter from the imessage skill.

Requires Full Disk Access for the process running this script.
"""
import datetime
import json
import os
import re
import sqlite3
import sys

OUT = os.path.join(os.environ.get("GAVIN_VOICE_LOCAL",
                                  "/Users/gkline/git-dev/gavin-voice-local"),
                   "corpus", "texts_raw.jsonl")
DB = os.path.expanduser("~/Library/Messages/chat.db")
# Apple epoch: 2001-01-01 UTC; dates are nanoseconds. Default window: 2.5 yrs.
CUTOFF_NS = int(os.environ.get("TEXTS_CUTOFF_NS", 738892800000000000))


def extract_streamtext(attributed_body):
    """streamtyped (NeXTstep) blobs: keep printable runs, drop ObjC class noise."""
    if not attributed_body:
        return None
    raw_strings = re.findall(rb'[\x20-\x7e]{3,}', attributed_body)
    skip_prefixes = (b'streamtyped', b'NS', b'NSMutable', b'__kIM', b'DDScanner', b'bplist')
    candidates = []
    for s in raw_strings:
        if s.startswith(skip_prefixes):
            continue
        decoded = s.decode('utf-8', 'replace')
        if not decoded.startswith('__') and len(decoded) >= 2:
            candidates.append(decoded)
    return ' '.join(candidates)[:1000] if candidates else None


def main():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    q = """
    SELECT m.ROWID as mid, m.text, m.attributedBody, m.is_from_me, m.date,
           h.id as handle, c.ROWID as chat_id, c.chat_identifier, c.display_name
    FROM message m
    JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    JOIN chat c ON cmj.chat_id = c.ROWID
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.date > ? AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
    ORDER BY m.date
    """
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n = 0
    with open(OUT, "w") as f:
        for r in conn.execute(q, (CUTOFF_NS,)):
            text = r["text"] or extract_streamtext(r["attributedBody"])
            if not text or not text.strip():
                continue
            f.write(json.dumps({
                "mid": r["mid"], "chat_id": r["chat_id"],
                "chat_identifier": r["chat_identifier"], "display_name": r["display_name"],
                "handle": r["handle"], "is_from_me": bool(r["is_from_me"]),
                "date": r["date"], "text": text.strip()
            }, ensure_ascii=False) + "\n")
            n += 1
    print(f"wrote {n} rows to {OUT}")


if __name__ == "__main__":
    main()
