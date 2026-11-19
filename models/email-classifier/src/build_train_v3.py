"""Build the v3 training set from the full-history labels.

The PROMOTION GATE stays the existing fixed held-out split: the exact 373
test-row ids frozen in data/gate_ids.json (cut 2026-09-15, labeled by the
v2 derivation). src/eval_model.py + src/scorecard.py keep scoring those
rows from data/labeled.jsonl, byte-for-byte comparable with the published
v1.5 bars. This script only decides what TRAINS:

  train       label_v3 rows dated before the cutoff, minus gate ids, plus
              every mark-read row (the class is only observable on the
              current inbox, exactly like is_train's v1 exception);
  holdout     post-cutoff rows NOT in the gate. They join neither set:
              training on them would put the gate's time window in train,
              which the standing-split design forbids. They are the first
              live-drift reconciliation batch for homelab issue #526.

Outputs data/labeled_v3_train.jsonl and mine/train_v3_stats.json
(aggregate counts + id lists only, no message content).
"""

from __future__ import annotations

import json
from pathlib import Path

from common import LABELS, TEST_CUTOFF_MS, data_dir, home


def main() -> int:
    gate = set(json.load(open(data_dir() / "gate_ids.json"))["ids"])
    rows = []
    with open(data_dir() / "labeled_v3.jsonl", encoding="utf-8") as fh:
        for line in fh:
            rows.append(json.loads(line))

    train, holdout, gate_hits = [], [], []
    for r in rows:
        if r["id"] in gate:
            gate_hits.append(r)
        elif r["label"] == "mark-read" or r["d"] < TEST_CUTOFF_MS:
            train.append(r)
        else:
            holdout.append(r)

    counts = {label: sum(1 for r in train if r["label"] == label)
              for label in LABELS}
    if min(counts.values()) == 0:
        raise SystemExit(f"empty class in v3 train set: {counts}")

    out_path = data_dir() / "labeled_v3_train.jsonl"
    with open(out_path, "w", encoding="utf-8") as fh:
        for r in sorted(train, key=lambda x: x["d"]):
            fh.write(json.dumps(r) + "\n")

    # v2-vs-v3 label disagreements on the frozen gate rows: the gate keeps
    # its v2 labels (comparability), but every disagreement is reported and
    # parked for the #526 reconciliation — never silently absorbed.
    v2 = {}
    with open(data_dir() / "labeled.jsonl", encoding="utf-8") as fh:
        for line in fh:
            r = json.loads(line)
            v2[r["id"]] = r["label"]
    gate_disagree = [
        {"id": r["id"], "v2": v2.get(r["id"]), "v3": r["label"]}
        for r in gate_hits if v2.get(r["id"]) != r["label"]
    ]

    mine = home() / "mine"
    with open(mine / "postcutoff_holdout_ids.json", "w", encoding="utf-8") as fh:
        json.dump({"reason": "post-cutoff non-gate; #526 reconciliation batch",
                   "ids": [r["id"] for r in holdout]}, fh)
    stats = {
        "v3_rows_total": len(rows),
        "train_rows": len(train),
        "train_counts": counts,
        "gate_rows_in_v3": len(gate_hits),
        "gate_disagreements": gate_disagree,
        "postcutoff_holdout": len(holdout),
    }
    with open(mine / "train_v3_stats.json", "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=2)

    print(f"v3 train: {len(train)} rows -> {out_path}")
    for label in LABELS:
        print(f"  {label:9s} {counts[label]}")
    print(f"gate rows re-derived by v3: {len(gate_hits)} "
          f"(disagreements with v2 labels: {len(gate_disagree)})")
    print(f"post-cutoff holdout (neither set, #526 batch): {len(holdout)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
