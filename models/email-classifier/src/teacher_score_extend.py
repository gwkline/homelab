"""Append-only extension of the banked teacher scores to new pool rows.

src/teacher_score.py scored the v3-era pool (64,888 rows) plus the frozen
gate (373) into artifacts/teacher-scores-v4.jsonl and REWRITES that file
whole — re-running it on a larger corpus would re-score everything. This
script never touches the banked rows: it loads the existing score ids,
scores only the pool rows that are MISSING (for the v6 complete corpus
that is the 30,209-row drain tail, all archive-class), and appends them
to the same file in pool order. Re-running after an interruption picks
up exactly the still-missing rows.

Scoring math is byte-identical to src/teacher_score.py: same tokenizer,
chat template, label-token ids, two-sequences-per-row packing to the
token-position budget, fp16 forward, float32 log-softmax over full-vocab
rows.

Verification before append: the banked file must hold the gate (373 rows)
and the gate parity check vs artifacts/neural-eval-v4.json must still
pass off the FILE contents (not this run's memory), so the appended
tail can never silently corrupt the reference rows. Outputs
artifacts/teacher-score-stats-v6-extension.json (throughput + counts,
aggregate only).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np

from common import home, is_train, train_path

LABEL_TOKENS = {
    "respond": [6818],
    "archive": [16019],
    "mark-read": [3987, 28806],
}
LABELS = ["respond", "archive", "mark-read"]
PROMPT = (
    "Predict the one action Gavin takes on this email: respond, archive, or "
    "mark-read. Answer with exactly one word, nothing else.\n\n"
    "From: {f}\nSubject: {s}\nBody: {n}"
)
BUDGET = int(os.environ.get("TS_TOKEN_BUDGET", "8192"))
PAD_ID = 151643


def fused_path() -> Path:
    return home() / "artifacts" / "neural-fused-v4"


def main() -> int:
    import mlx.core as mx
    from mlx_lm import load
    from transformers import AutoTokenizer

    out_path = home() / "artifacts" / "teacher-scores-v4.jsonl"
    existing: dict[str, dict] = {}
    with open(out_path, encoding="utf-8") as fh:
        for line in fh:
            r = json.loads(line)
            existing[r["id"]] = r
    gate_in_file = sum(1 for r in existing.values() if r["split"] == "gate")
    pool_in_file = sum(1 for r in existing.values() if r["split"] == "pool")
    print(f"banked scores: {len(existing)} rows "
          f"({pool_in_file} pool, {gate_in_file} gate)", flush=True)
    if gate_in_file != 373:
        raise SystemExit(f"banked file lost its gate rows: {gate_in_file}")

    # --- gate parity off the FILE, before any append ----------------------
    gate_threshold = float(json.load(
        open(fused_path() / "threshold.json", encoding="utf-8")
    )["respond_threshold"])
    ref = json.load(open(home() / "artifacts" / "neural-eval-v4.json",
                         encoding="utf-8"))
    ref_by_id = dict(zip(ref["ids"], zip(ref["y_pred"], ref["p_respond"])))
    match, p_diff_max = 0, 0.0
    for gid, (y_ref, p_ref) in ref_by_id.items():
        sc = existing[gid]
        y_file = "respond" if sc["p_respond"] >= gate_threshold else sc["rest"]
        match += int(y_file == y_ref)
        p_diff_max = max(p_diff_max, abs(sc["p_respond"] - p_ref))
    print(f"banked gate parity: {match}/{len(ref_by_id)} thresholded "
          f"predictions match; max |dp_respond| = {p_diff_max:.2e}", flush=True)
    if match != len(ref_by_id):
        raise SystemExit("banked gate parity broken — refusing to append")

    pool = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    pool = [r for r in pool if is_train(r)]
    rows = [r for r in pool if r["id"] not in existing]
    print(f"pool rows {len(pool)}; missing teacher scores: {len(rows)} "
          f"({sum(1 for r in rows if r['label'] == 'respond')} respond, "
          f"{sum(1 for r in rows if r['label'] == 'mark-read')} mark-read)",
          flush=True)
    if not rows:
        print("nothing to extend", flush=True)
        return 0

    model, _ = load(str(fused_path()))
    tok = AutoTokenizer.from_pretrained(str(fused_path()))

    # --- tokenize + pack (identical to teacher_score.py) ------------------
    recs = []
    for i, r in enumerate(rows):
        text = tok.apply_chat_template(
            [{"role": "user",
              "content": PROMPT.format(f=r["from"], s=r["subject"],
                                       n=r["snippet"])}],
            add_generation_prompt=True, tokenize=False)
        a = tok.encode(text, add_special_tokens=False)
        recs.append((len(a), i, a, a + [LABEL_TOKENS["mark-read"][0]]))
    recs.sort(key=lambda t: t[0])
    print(f"tokenized (median prompt {recs[len(recs) // 2][0]} tokens, "
          f"max {recs[-1][0]})", flush=True)

    batches = []
    cur, cur_max = [], 0
    for rec in recs:
        plen, _i, _a, _b = rec
        new_max = max(cur_max, plen + 1)
        n_seq = len(cur) + 2
        if cur and n_seq * new_max > BUDGET:
            batches.append(cur)
            cur, cur_max = [], 0
            new_max = plen + 1
        cur.append(rec)
        cur_max = max(cur_max, new_max)
    if cur:
        batches.append(cur)
    n_seq_total = sum(2 * len(b) for b in batches)
    print(f"{len(batches)} batches, {n_seq_total} sequences, "
          f"budget {BUDGET} positions", flush=True)

    # --- score, appending as we go (crash-resumable) ---------------------
    scores: dict[int, dict] = {}
    t0 = time.time()
    done_rows = 0
    appended = 0
    with open(out_path, "a", encoding="utf-8") as fh:
        for bi, batch in enumerate(batches):
            seqs, extract = [], []
            for plen, ri, a, b in batch:
                sa = len(seqs)
                seqs.append(a)
                extract.append((sa, plen - 1, ri, "A"))
                sb = len(seqs)
                seqs.append(b)
                extract.append((sb, plen - 1, ri, "B1"))
                extract.append((sb, plen, ri, "B2"))
            L = max(len(s) for s in seqs)
            padded = mx.array([s + [PAD_ID] * (L - len(s)) for s in seqs])
            logits = model(padded)
            mx.eval(logits)

            lp = {}
            for slot, pos, ri, kind in extract:
                row = np.asarray(logits[slot, pos].astype(mx.float32))
                peak = row.max(axis=-1, keepdims=True)
                lse = np.log(np.exp(row - peak).sum(axis=-1, keepdims=True))
                lp[(ri, kind)] = row - peak - lse

            for plen, ri, a, b in batch:
                A = lp[(ri, "A")]
                B1 = lp[(ri, "B1")]
                B2 = lp[(ri, "B2")]
                s = {
                    "respond": float(A[LABEL_TOKENS["respond"][0]]),
                    "archive": float(A[LABEL_TOKENS["archive"][0]]),
                    "mark-read": float(B1[LABEL_TOKENS["mark-read"][0]]
                                       + B2[LABEL_TOKENS["mark-read"][1]]),
                }
                m = max(s.values())
                exps = {k: np.exp(v - m) for k, v in s.items()}
                z = sum(exps.values())
                scores[ri] = {
                    "p_respond": exps["respond"] / z,
                    "p_archive": exps["archive"] / z,
                    "p_markread": exps["mark-read"] / z,
                    "argmax": max(LABELS, key=lambda k: s[k]),
                    "rest": max((k for k in LABELS if k != "respond"),
                                key=lambda k: s[k]),
                }
            done_rows += len(batch)

            # append this batch's rows in pool order
            for plen, ri, a, b in batch:
                sc = scores[ri]
                fh.write(json.dumps({
                    "id": rows[ri]["id"], "split": "pool",
                    "p_respond": round(sc["p_respond"], 6),
                    "p_archive": round(sc["p_archive"], 6),
                    "p_markread": round(sc["p_markread"], 6),
                    "argmax": sc["argmax"], "rest": sc["rest"],
                }) + "\n")
                appended += 1
            if bi % 25 == 0 or bi == len(batches) - 1:
                fh.flush()
                el = time.time() - t0
                rps = done_rows / el
                eta = (len(rows) - done_rows) / rps if rps else 0
                print(f"batch {bi + 1}/{len(batches)}  rows {done_rows}/"
                      f"{len(rows)}  {rps:.1f} rows/s  eta {eta / 60:.1f}m",
                      flush=True)

    wall = time.time() - t0
    total = len(existing) + appended
    flagged = sum(1 for ri in scores if scores[ri]["p_respond"] >= gate_threshold)

    # --- readback ---------------------------------------------------------
    with open(out_path, encoding="utf-8") as fh:
        n_after = sum(1 for _ in fh)
    print(f"appended {appended} rows; file now {n_after} rows "
          f"(expected {total})", flush=True)
    if n_after != total:
        raise SystemExit(f"readback mismatch: {n_after} != {total}")

    stats = {
        "model": "neural-fused-v4 (qwen25-15b-instruct-4bit + LoRA, fused)",
        "mode": "append-only extension (banked rows untouched)",
        "banked_rows": len(existing),
        "banked_gate_parity": {"pred_match": match,
                               "ref_rows": len(ref_by_id),
                               "max_abs_dp_respond":
                                   float(f"{p_diff_max:.2e}")},
        "appended_rows": appended,
        "appended_respond_flagged": flagged,
        "pool_rows_total": len(pool),
        "file_rows_after": n_after,
        "token_budget": BUDGET,
        "batches": len(batches),
        "sequences": n_seq_total,
        "wall_s": round(wall, 1),
        "rows_per_s": round(appended / wall, 2),
    }
    stats_path = home() / "artifacts" / "teacher-score-stats-v6-extension.json"
    with open(stats_path, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, indent=2)
    print(f"wrote {stats_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
