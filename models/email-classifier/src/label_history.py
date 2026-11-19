"""Label the FULL mailbox history sweep (v3 data expansion).

Consumes the threads.get sweep produced by fetch/mine_history.py:

  $EMAIL_CLASSIFIER_HOME/mine/threads_raw.jsonl  {"t","n","m":[…],"x":[tail ids]}
  $EMAIL_CLASSIFIER_HOME/mine/xmeta_raw.jsonl   per-message rows for the
                                                 >100-message thread tails

and derives behavior labels with the SAME rules src/label.py has used since
v1 (verified against the v2 file on every shared id — see the agreement
audit at the end of the output):

  respond    the incoming message that immediately precedes a sent reply;
  mark-read   inbox message that was read and left there (no reply, no
             archive) — only observable on the current inbox;
  archive    archived without a reply.

v3 sweep additions (the v1/v2 exports pre-filtered these with Gmail q
queries; the full sweep sees everything, so the filters moved here):
  TRASH/SPAM/DRAFT rows are skipped (deleting is not archiving, and spam
  never joins the serving population), sent rows are never labeled, and
  unread incoming rows carry no behavior signal yet.

Output: data/labeled_v3.jsonl with
  {"id","t","label","d","from","subject","snippet","lu","pc","era"}
plus mine/v3_stats.json — aggregate counts only, no message content.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import LABELS, data_dir, home, labeled_path

SKIP_LABELS = ("TRASH", "SPAM", "DRAFT")


def era_of(ms: int) -> int:
    if not ms:
        return 0
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).year


def load_xmeta(mine: Path) -> dict:
    by_id = {}
    path = mine / "xmeta_raw.jsonl"
    if path.exists():
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                    by_id[r["i"]] = r
                except (json.JSONDecodeError, KeyError):
                    continue
    return by_id


def iter_threads(mine: Path):
    path = mine / "threads_raw.jsonl"
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def label_threads(threads, xmeta):
    """respond = each incoming message that immediately precedes a sent
    reply — verbatim the v1/v2 rule, including 'Gavin initiated the
    thread' producing no trigger."""
    triggers = {}
    for tid, msgs in threads:
        incoming = [m for m in msgs if "SENT" not in (m.get("L") or [])]
        for msg in msgs:
            if "SENT" not in (msg.get("L") or []):
                continue
            prior = [m for m in incoming if (m.get("d") or 0) < (msg.get("d") or 0)]
            if not prior:
                continue
            trig = max(prior, key=lambda m: m.get("d") or 0)
            triggers[trig["i"]] = trig
    return triggers


def main() -> int:
    mine = home() / "mine"
    if not (mine / "threads_raw.jsonl").exists():
        raise SystemExit("no sweep data: run fetch/mine_history.py first")
    xmeta = load_xmeta(mine)

    stats = {
        "threads_seen": 0,
        "messages_seen": 0,
        "unresolved_tails": 0,
        "sent_rows": 0,
        "skipped": {"unread": 0, "trash_spam_draft": 0, "no_date": 0},
        "threads_sent_only": 0,
        "class_counts": {label: 0 for label in LABELS},
        "by_year": {},
    }
    out = {}
    order = {"respond": 0, "mark-read": 1, "archive": 2}

    def add(mid, thread, label, m):
        if mid in out and order[out[mid]["label"]] <= order[label]:
            return
        out[mid] = {
            "id": mid,
            "t": thread,
            "label": label,
            "d": int(m.get("d") or 0),
            "from": m.get("f", ""),
            "subject": m.get("s", ""),
            "snippet": m.get("n", ""),
            "lu": m.get("lu", 0),
            "pc": m.get("pc", ""),
            "era": era_of(int(m.get("d") or 0)),
        }

    threads = []
    for raw in iter_threads(mine):
        stats["threads_seen"] += 1
        msgs = list(raw.get("m", []))
        stats["messages_seen"] += raw.get("n", len(msgs))
        for mid in raw.get("x", []):
            if mid in xmeta:
                xm = xmeta[mid]
                msgs.append({
                    "i": xm["i"], "d": xm["d"], "L": xm["L"],
                    "f": xm.get("f", ""), "s": xm.get("s", ""),
                    "n": xm.get("n", ""), "lu": xm.get("lu", 0),
                    "pc": xm.get("pc", ""),
                })
            else:
                stats["unresolved_tails"] += 1
        msgs.sort(key=lambda m: m.get("d") or 0)
        stats["sent_rows"] += sum(
            1 for m in msgs if "SENT" in (m.get("L") or []))
        if all("SENT" in (m.get("L") or []) for m in msgs) and msgs:
            stats["threads_sent_only"] += 1
        threads.append((raw.get("t"), msgs))

    triggers = label_threads(threads, xmeta)
    for tid, msgs in threads:
        for m in msgs:
            mid = m.get("i")
            labels = m.get("L") or []
            if not mid or not (m.get("d") or 0):
                stats["skipped"]["no_date"] += 1
                continue
            if "SENT" in labels:
                continue
            if any(s in labels for s in SKIP_LABELS):
                stats["skipped"]["trash_spam_draft"] += 1
                continue
            if mid in triggers:
                add(mid, tid, "respond", m)
                continue
            if "UNREAD" in labels:
                stats["skipped"]["unread"] += 1
                continue
            label = "mark-read" if "INBOX" in labels else "archive"
            add(mid, tid, label, m)

    for row in out.values():
        stats["class_counts"][row["label"]] += 1
        stats["by_year"].setdefault(str(row["era"]), {})
        stats["by_year"][str(row["era"])][row["label"]] = (
            stats["by_year"][str(row["era"])].get(row["label"], 0) + 1
        )

    # v2 agreement audit: every id labeled by BOTH derivations. Aggregate
    # counts only — this is the drift/consistency check, not a gate.
    v2 = {}
    if labeled_path().exists():
        with open(labeled_path(), encoding="utf-8") as fh:
            for line in fh:
                r = json.loads(line)
                v2[r["id"]] = r["label"]
    agree = {label: 0 for label in LABELS}
    disagree = {}
    for mid, label in ((i, r["label"]) for i, r in out.items()):
        if mid not in v2:
            continue
        if v2[mid] == label:
            agree[label] += 1
        else:
            disagree.setdefault(f"{v2[mid]}->{label}", []).append(mid)
    stats["v2_agreement"] = {
        "shared_ids": sum(agree.values()) + sum(len(v) for v in disagree.values()),
        "agree": agree,
        "disagree_counts": {k: len(v) for k, v in sorted(disagree.items())},
    }

    out_path = data_dir() / "labeled_v3.jsonl"
    with open(out_path, "w", encoding="utf-8") as fh:
        for row in sorted(out.values(), key=lambda r: r["d"]):
            fh.write(json.dumps(row) + "\n")

    stats_path = mine / "v3_stats.json"
    with open(stats_path, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=2)

    print(f"labeled_v3: {len(out)} rows -> {out_path}")
    for label in LABELS:
        print(f"  {label:9s} {stats['class_counts'][label]}")
    print(f"threads {stats['threads_seen']}, messages {stats['messages_seen']}"
          f" (sent {stats['sent_rows']}, sent-only threads "
          f"{stats['threads_sent_only']})")
    print(f"skipped: {stats['skipped']}, unresolved tails: "
          f"{stats['unresolved_tails']}")
    va = stats["v2_agreement"]
    print(f"v2 agreement: {va['shared_ids']} shared ids, "
          f"agree {sum(va['agree'].values())}, "
          f"disagree {sum(va['disagree_counts'].values())} "
          f"{va['disagree_counts']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
