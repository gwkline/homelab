"""v6 selection VAL carve: sender-disjoint, whole-sender.

The v5 postmortem (PR #544, evals/distill-scorecard.md): the v4 VAL carved
ROWS, so 50 of its 58 senders also appeared in the fit pool. The student's
frozen sender-prior feature was therefore super-informative ON VAL — the
tune picked the no-boost config (pure prior reliance, VAL respond F1
0.783) and that selection failed to transfer to the frozen gate (0.491).
The gate's post-cutoff mail is dominated by senders the priors have weak
or no history for, so the honest selection carve must reproduce that
condition: NO sender may appear in both VAL and fit.

Construction (deterministic, seeded by the corpus alone):

  1. candidates are senders with at least one row in the pre-cutoff 2026
     window (the same era proxy the v4 carve used);
  2. every sender with a respond row in that window joins VAL first —
     this carries over the v4 carve's 27 window respond rows, the entire
     tuning signal for the primary metric;
  3. archive-only candidate senders join in ascending TOTAL pool
     footprint (ties by address) until VAL holds ~555 rows — small
     rare-correspondent senders first, the most gate-like senders;
  4. VAL takes each chosen sender's ENTIRE pool footprint, any era, so
     fit can never contain a VAL sender (whole-sender disjointness —
     out-of-window rows of a chosen sender would otherwise re-leak the
     prior through fit's prior pool).

Outputs mine/val_ids_v6.json (frozen ids) and prints the disjointness
proof + composition. Aggregate counts only — no message content.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO_SRC = str(Path(__file__).resolve().parent)
sys.path.insert(0, REPO_SRC)

from common import (  # noqa: E402
    TEST_CUTOFF_MS,
    home,
    is_train,
    sender_email,
    train_path,
)

WINDOW_START_MS = 1767225600000  # 2026-01-01T00:00:00Z
TARGET_ROWS = 555


def main() -> int:
    pool = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    pool = [r for r in pool if is_train(r)]

    by_sender: dict[str, list] = defaultdict(list)
    for r in pool:
        by_sender[sender_email(r["from"])].append(r)

    window_senders = {
        s for s, rows in by_sender.items()
        if any(WINDOW_START_MS <= r["d"] < TEST_CUTOFF_MS for r in rows)
    }
    resp_senders = {
        s for s in window_senders
        if any(r["label"] == "respond"
               for r in by_sender[s]
               if WINDOW_START_MS <= r["d"] < TEST_CUTOFF_MS)
    }

    chosen = set(resp_senders)
    val_rows = [r for s in chosen for r in by_sender[s]]
    archive_only = sorted(
        (s for s in window_senders if s not in chosen),
        key=lambda s: (len(by_sender[s]), s))
    for s in archive_only:
        if len(val_rows) >= TARGET_ROWS:
            break
        chosen.add(s)
        val_rows.extend(by_sender[s])

    val_ids = sorted(r["id"] for r in val_rows)
    fit_rows = [r for r in pool if r["id"] not in set(val_ids)]

    # --- the proof --------------------------------------------------------
    val_senders = {sender_email(r["from"]) for r in val_rows}
    fit_senders = {sender_email(r["from"]) for r in fit_rows}
    shared = val_senders & fit_senders
    print(f"pool rows {len(pool)} -> VAL {len(val_rows)} / fit {len(fit_rows)}")
    print(f"VAL senders {len(val_senders)}; fit senders {len(fit_senders)}; "
          f"SHARED SENDERS {len(shared)}")
    if shared:
        raise SystemExit(f"sender-disjoint carve violated: {len(shared)} "
                          f"shared senders (first {sorted(shared)[0]})")
    if not val_ids:
        raise SystemExit("empty carve")

    val_counts = Counter(r["label"] for r in val_rows)
    win_resp = sum(1 for r in val_rows
                   if r["label"] == "respond"
                   and WINDOW_START_MS <= r["d"] < TEST_CUTOFF_MS)
    print(f"VAL composition {dict(val_counts)} "
          f"(window respond rows {win_resp}); "
          f"respond share {val_counts['respond'] / len(val_rows) * 100:.1f}%")

    out = home() / "mine" / "val_ids_v6.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({
            "ids": val_ids,
            "senders": sorted(chosen),
            "rule": ("sender-disjoint whole-sender carve: 2026-window "
                     "senders, respond-bearing first, archive-only by "
                     "ascending footprint; VAL = entire pool footprint "
                     "of each chosen sender"),
            "window_start_ms": WINDOW_START_MS,
            "target_rows": TARGET_ROWS,
        }, fh, indent=2)
    print(f"wrote {out} ({len(val_ids)} ids, {len(chosen)} senders)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
