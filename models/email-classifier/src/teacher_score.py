"""Batch teacher scoring: the fused neural-v4 LM over the pool + gate.

Scores every training-pool row (EMAIL_CLASSIFIER_TRAIN, filtered by
src/common.is_train) and the frozen gate with the deployed teacher —
src/train_neural_v4.py's label-logprob method EXACTLY (same tokenizer,
same chat template, same float32 log-softmax over full-vocab rows),
but batched across rows for throughput:

  per row, TWO sequences instead of three — "respond" and "archive" are
  single tokens, so both scores come from the prompt-only forward's
  last position; "mark-read" is two tokens, so a second sequence
  prompt+"mark" yields both its terms. Causal attention makes the shared
  prefix positionwise-identical, so scores match the serial
  3-sequence path; the script verifies by reproducing the gate row of
  artifacts/neural-eval-v4.json (ids + p_respond + thresholded
  predictions) and exits nonzero on any mismatch.

Sequences are sorted by prompt length and packed to a token-position
budget (TS_TOKEN_BUDGET, default 8192), so padding waste stays near zero
and the [S, L, V] logits tensor stays bounded (~2.5 GiB fp16 at the
default). TS_LIMIT scores only the first N pool rows (smoke runs).

Requires the mlx venv (mlx-lm is not part of the serving requirements);
the fused model lives at EMAIL_CLASSIFIER_HOME/artifacts/neural-fused-v4
with its serving threshold in threshold.json.

Outputs (message-derived, stay under EMAIL_CLASSIFIER_HOME — never
committed): artifacts/teacher-scores-v4.jsonl (id, split, p_respond,
p_archive, p_markread, argmax, rest) + artifacts/teacher-score-stats.json
(throughput + parity readback, aggregate only).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np

from common import data_dir, home, is_test, is_train, labeled_path, train_path

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
LIMIT = int(os.environ["TS_LIMIT"]) if os.environ.get("TS_LIMIT") else 0
PAD_ID = 151643


def fused_path() -> Path:
    return home() / "artifacts" / "neural-fused-v4"


def load_rows() -> list:
    pool = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    pool = [r for r in pool if is_train(r)]
    for r in pool:
        r["_split"] = "pool"
    gate_ids = set(json.load(open(data_dir() / "gate_ids.json"))["ids"])
    lab = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    gate = sorted((r for r in lab if r["id"] in gate_ids and is_test(r)),
                  key=lambda r: r["d"])
    for r in gate:
        r["_split"] = "gate"
    if len(gate) != 373:
        raise SystemExit(f"instrument drift: gate resolved to {len(gate)} rows")
    if LIMIT:
        pool = pool[:LIMIT]
    return pool + gate


def main() -> int:
    import mlx.core as mx
    from mlx_lm import load
    from transformers import AutoTokenizer

    fused = fused_path()
    model, _ = load(str(fused))
    tok = AutoTokenizer.from_pretrained(str(fused))
    gate_threshold = float(json.load(
        open(fused / "threshold.json", encoding="utf-8"))["respond_threshold"])

    rows = load_rows()
    print(f"rows to score: {len(rows)} "
          f"({sum(1 for r in rows if r['_split'] == 'pool')} pool, "
          f"{sum(1 for r in rows if r['_split'] == 'gate')} gate)", flush=True)

    # --- tokenize + build per-row sequence records -----------------------
    t_tok = time.time()
    recs = []  # (prompt_len, row_idx, seqA, seqB)
    for i, r in enumerate(rows):
        text = tok.apply_chat_template(
            [{"role": "user",
              "content": PROMPT.format(f=r["from"], s=r["subject"],
                                       n=r["snippet"])}],
            add_generation_prompt=True, tokenize=False)
        a = tok.encode(text, add_special_tokens=False)
        recs.append((len(a), i, a, a + [LABEL_TOKENS["mark-read"][0]]))
    recs.sort(key=lambda t: t[0])
    print(f"tokenized in {time.time() - t_tok:.1f}s "
          f"(median prompt {recs[len(recs) // 2][0]} tokens, "
          f"max {recs[-1][0]})", flush=True)

    # --- batch to the token-position budget ------------------------------
    batches = []
    cur, cur_max = [], 0
    for rec in recs:
        plen, _i, _a, _b = rec
        new_max = max(cur_max, plen + 1)  # seqB is prompt+1 token
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

    # --- score ------------------------------------------------------------
    scores: dict[int, dict] = {}
    t0 = time.time()
    done_rows = 0
    for bi, batch in enumerate(batches):
        seqs, extract = [], []  # extract: (seq_slot, pos, row_idx, kind)
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
        mx.eval(logits)  # materialize once; slices never recompute

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
        if bi % 25 == 0 or bi == len(batches) - 1:
            el = time.time() - t0
            rps = done_rows / el
            eta = (len(rows) - done_rows) / rps if rps else 0
            print(f"batch {bi + 1}/{len(batches)}  rows {done_rows}/{len(rows)}"
                  f"  {rps:.1f} rows/s  eta {eta / 60:.1f}m", flush=True)

    # --- write scores ------------------------------------------------------
    out_path = home() / "artifacts" / "teacher-scores-v4.jsonl"
    with open(out_path, "w", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            sc = scores[i]
            fh.write(json.dumps({
                "id": r["id"], "split": r["_split"],
                "p_respond": round(sc["p_respond"], 6),
                "p_archive": round(sc["p_archive"], 6),
                "p_markread": round(sc["p_markread"], 6),
                "argmax": sc["argmax"], "rest": sc["rest"],
            }) + "\n")
    print(f"wrote {out_path} ({len(rows)} rows)", flush=True)

    # --- verification: gate parity vs the serial v4 eval ------------------
    gate_idx = {r["id"]: i for i, r in enumerate(rows)
                if r["_split"] == "gate"}
    ref_path = home() / "artifacts" / "neural-eval-v4.json"
    ref = json.load(open(ref_path, encoding="utf-8"))
    ref_by_id = dict(zip(ref["ids"], zip(ref["y_pred"], ref["p_respond"])))
    match, p_diff_max = 0, 0.0
    for gid, (y_ref, p_ref) in ref_by_id.items():
        sc = scores[gate_idx[gid]]
        y_batch = ("respond" if sc["p_respond"] >= gate_threshold
                   else sc["rest"])
        match += int(y_batch == y_ref)
        p_diff_max = max(p_diff_max, abs(sc["p_respond"] - p_ref))
    print(f"gate parity: {match}/{len(ref_by_id)} thresholded predictions "
          f"match neural-eval-v4.json; max |dp_respond| = {p_diff_max:.2e}",
          flush=True)

    stats = {
        "model": "neural-fused-v4 (qwen25-15b-instruct-4bit + LoRA, fused)",
        "rows": len(rows),
        "pool_rows": sum(1 for r in rows if r["_split"] == "pool"),
        "gate_rows": sum(1 for r in rows if r["_split"] == "gate"),
        "token_budget": BUDGET,
        "batches": len(batches),
        "sequences": n_seq_total,
        "wall_s": round(time.time() - t0, 1),
        "rows_per_s": round(len(rows) / (time.time() - t0), 2),
        "gate_threshold": gate_threshold,
        "gate_parity": {"pred_match": match, "ref_rows": len(ref_by_id),
                        "max_abs_dp_respond": float(f"{p_diff_max:.2e}")},
        "method": "2 sequences/row (single-token respond+archive from the "
                  "prompt forward; mark-read from prompt+'mark'), fp16 "
                  "forward, float32 log-softmax over full vocab rows — "
                  "identical math to src/train_neural_v4.py",
    }
    with open(home() / "artifacts" / "teacher-score-stats.json", "w",
              encoding="utf-8") as fh:
        json.dump(stats, fh, indent=2)
    print(f"wrote {home() / 'artifacts' / 'teacher-score-stats.json'}",
          flush=True)
    return 0 if match == len(ref_by_id) else 3


if __name__ == "__main__":
    raise SystemExit(main())
