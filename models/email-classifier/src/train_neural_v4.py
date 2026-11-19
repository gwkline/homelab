"""Neural v4 candidate: Qwen2.5-1.5B-Instruct + LoRA, 3-way classification.

Same prompt and label-token scoring shape as the v3 Qwen2.5-0.5B candidate
(src/train_neural.py), sized up per the v4 mandate ("1.5B-class LM") now
that the full-history corpus justifies the capacity. Qwen2.5-1.5B keeps
the exact tokenizer + chat template of the proven 0.5B pipeline (no
thinking-mode template interplay with label-token scoring); Qwen3-1.7B was
considered and passed over for exactly that reason.

Stages via argv[1], all run under EMAIL_CLASSIFIER_HOME's .venv-mlx:

  prep   chat-format train/valid from the v3 train pool MINUS the frozen
         v4 VAL carve (mine/val_ids_v4.json — the same out-of-sample rows
         src/train_v4.py selects and tunes on), respond 20x / mark-read 8x
         oversample; valid = seeded stratified 15% per class, so the val
         curve can actually see respond; val.jsonl holds the carve rows
         for scoring.
  train  mlx-lm LoRA: lr 5e-5, last 16 layers, batch 8, seq 384,
         mask-prompt, iters 480 (env NEURAL_V4_ITERS) — under the ~550
         iter NaN horizon documented for this recipe family. Checkpoints
         every 80 steps, val every 80 steps so every val point has a
         checkpoint to promote.
  fuse   parse the training log (ANSI-stripped), promote the VAL-BEST
         checkpoint (a NaN tail never poisons earlier checkpoints), fuse
         with --dequantize.
  eval   label-token log-prob scores; softmax over the three labels;
         threshold tuned on VAL with the same archive-F1 floor as the
         classical lane; ONE pass over the frozen gate. Writes
         artifacts/neural-eval-v4.json (ids + predictions + p_respond,
         aggregate only) and mine/neural-v4-report.json.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from common import home, is_test, is_train, labeled_path, train_path

PROMPT = (
    "Predict the one action Gavin takes on this email: respond, archive, or "
    "mark-read. Answer with exactly one word, nothing else.\n\n"
    "From: {f}\nSubject: {s}\nBody: {n}"
)
OVERSAMPLE = {"respond": 20, "mark-read": 8}
# 20x respond: the v2-era 3x factor assumed the old corpus's ~26% respond
# share; the full-history pool is 3.7% respond, so 3x left respond at ~11%
# of the sampler and the LoRA collapsed to always-archive (observed: val
# loss 0.002 on an all-archive val slice, iter 80 of the first v4 run).
# 20x restores the ~50% respond share the 0.5B recipe actually trained on.
LABELS = ["respond", "archive", "mark-read"]
ARCHIVE_F1_FLOOR = 0.90


def data_dir() -> Path:
    return home() / "artifacts" / "neural-data-v4"


def adapter_path() -> Path:
    return home() / "artifacts" / "neural-adapter-v4"


def fused_path() -> Path:
    return home() / "artifacts" / "neural-fused-v4"


def base_path() -> Path:
    return home() / "artifacts" / os.environ.get(
        "NEURAL_V4_BASE", "qwen25-15b-instruct-4bit")


def chat(row: dict) -> dict:
    return {
        "messages": [
            {
                "role": "user",
                "content": PROMPT.format(
                    f=row["from"], s=row["subject"], n=row["snippet"]
                ),
            },
            {"role": "assistant", "content": row["label"]},
        ]
    }


def val_rows() -> list:
    """The frozen v4 VAL carve, raw rows (labels included)."""
    ids = set(json.load(open(home() / "mine" / "val_ids_v4.json"))["ids"])
    pool = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    return sorted((r for r in pool if is_train(r) and r["id"] in ids),
                  key=lambda r: r["d"])


def prep() -> int:
    ids = set(json.load(open(home() / "mine" / "val_ids_v4.json"))["ids"])
    rows = [json.loads(line) for line in open(train_path(), encoding="utf-8")]
    fit = [r for r in rows if is_train(r) and r["id"] not in ids]
    # Stratified random valid (seeded, 15% per class): a date split parks the
    # whole validation slice in the 2026 archive monoculture — zero respond
    # rows — which cannot see respond collapse (the first v4 run's val
    # loss hit 0.002 while the model predicted nothing but archive). The
    # frozen gate is untouched either way; this only fixes what the LoRA
    # val curve is allowed to measure. mark-read stays all-train.
    import random

    rng = random.Random(20261119)
    valid, fit_train = [], []
    for label in LABELS:
        sub = sorted((r for r in fit if r["label"] == label),
                     key=lambda r: r["d"])
        k = max(1, int(len(sub) * 0.15))
        take = set(rng.sample(range(len(sub)), k))
        valid.extend(sub[i] for i in take)
        fit_train.extend(sub[i] for i in range(len(sub)) if i not in take)

    out = data_dir()
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "train.jsonl", "w", encoding="utf-8") as fh:
        for r in fit_train:
            for _ in range(OVERSAMPLE.get(r["label"], 1)):
                fh.write(json.dumps(chat(r)) + "\n")
    with open(out / "valid.jsonl", "w", encoding="utf-8") as fh:
        for r in valid:
            fh.write(json.dumps(chat(r)) + "\n")
    counts = {label: sum(1 for r in fit_train if r["label"] == label)
              for label in LABELS}
    vcounts = {label: sum(1 for r in valid if r["label"] == label)
               for label in LABELS}
    n_train = sum(OVERSAMPLE.get(r["label"], 1) for r in fit_train)
    print(f"train rows (oversampled): {n_train}, valid rows: {len(valid)}")
    print(f"fit counts: {counts}; valid counts: {vcounts}; "
          f"val carve excluded: {len(ids)} ids")
    return 0


def parse_val_curve(log_text: str) -> list:
    """(iter, val) pairs from an ANSI-colored mlx-lm 0.32 log. The val
    report is its own table line — "  240    val 0.131    25.98s" — so
    parse per-line; `val nan` lines never match the digit regex and are
    excluded by construction."""
    clean = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", log_text).replace("\r", "\n")
    return [(int(m.group(1)), float(m.group(2)))
            for m in re.finditer(r"^\s*(\d+)\s+val\s+([\d.]+)", clean,
                                 re.MULTILINE)]


def train() -> int:
    iters = os.environ.get("NEURAL_V4_ITERS", "480")
    lr = os.environ.get("NEURAL_V4_LR", "5e-5")
    adapter_path().mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, "-m", "mlx_lm", "lora",
        "--model", str(base_path()),
        "--train",
        "--data", str(data_dir()),
        "--fine-tune-type", "lora",
        "--num-layers", "16",
        "--batch-size", "8",
        "--iters", iters,
        "--learning-rate", lr,
        "--mask-prompt",
        "--max-seq-length", "384",
        "--steps-per-eval", "80",
        "--val-batches", "25",
        "--save-every", "80",
        "--adapter-path", str(adapter_path()),
    ]
    log_path = home() / "logs" / "neural-v4-train.log"
    print(" ".join(cmd), flush=True)
    with open(log_path, "w", encoding="utf-8") as fh:
        subprocess.run(cmd, check=True, stdout=fh, stderr=subprocess.STDOUT)
    print(f"training log -> {log_path}")
    return 0


def fuse() -> int:
    log_path = home() / "logs" / "neural-v4-train.log"
    curve = parse_val_curve(Path(log_path).read_text(encoding="utf-8"))
    if not curve:
        raise SystemExit("no val lines parsed from the training log; "
                         "refusing to fuse blind")
    best_iter, best_val = min(curve, key=lambda kv: kv[1])
    print(f"val curve: {curve}")
    print(f"val-best: iter {best_iter} (val {best_val:.4f})")

    ckpt = adapter_path() / f"{best_iter:07d}_adapters.safetensors"
    if not ckpt.exists():
        cands = [int(p.name.split("_")[0]) for p in
                 adapter_path().glob("*_adapters.safetensors")]
        take = max(i for i in cands if i <= best_iter)
        ckpt = adapter_path() / f"{take:07d}_adapters.safetensors"
        print(f"no checkpoint at {best_iter}; using {take}")
    stage = home() / "artifacts" / "neural-fuse-input-v4"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    shutil.copy(adapter_path() / "adapter_config.json", stage / "adapter_config.json")
    shutil.copy(ckpt, stage / "adapters.safetensors")
    cmd = [
        sys.executable, "-m", "mlx_lm", "fuse",
        "--model", str(base_path()),
        "--adapter-path", str(stage),
        "--save-path", str(fused_path()),
        "--dequantize",
    ]
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    print(f"fused -> {fused_path()}")
    return 0


def evaluate() -> int:
    import math

    import mlx.core as mx
    from mlx_lm import load
    from sklearn.metrics import classification_report
    from transformers import AutoTokenizer

    model, _tok = load(str(fused_path()))
    tok = AutoTokenizer.from_pretrained(str(fused_path()))

    def prompt_for(row):
        messages = [{"role": "user",
                     "content": PROMPT.format(f=row["from"], s=row["subject"],
                                               n=row["snippet"])}]
        return tok.apply_chat_template(messages, add_generation_prompt=True,
                                       tokenize=False)

    def label_scores(row):
        text = prompt_for(row)
        ids_prompt = tok.encode(text, add_special_tokens=False)
        scores = {}
        for label in LABELS:
            ids_label = tok.encode(label, add_special_tokens=False)
            ids = mx.array([ids_prompt + ids_label])
            logits = model(ids)
            arr = np.asarray(logits[0].astype(mx.float32))
            peak = arr.max(axis=-1, keepdims=True)
            logprobs = arr - peak - np.log(
                np.exp(arr - peak).sum(axis=-1, keepdims=True))
            total = 0.0
            for k, t in enumerate(ids_label):
                total += float(logprobs[len(ids_prompt) + k - 1, t])
            scores[label] = total
        return scores

    def prob_rows(rows):
        """p_respond (softmax over the three summed label scores) per row."""
        out = []
        for row in rows:
            s = label_scores(row)
            m = max(s.values())
            exps = {k: math.exp(v - m) for k, v in s.items()}
            z = sum(exps.values())
            p_resp = exps["respond"] / z
            rest = max((k for k in LABELS if k != "respond"),
                       key=lambda k: s[k])
            out.append({"p": p_resp, "argmax": max(s, key=s.get),
                        "rest": rest})
        return out

    import numpy as np

    def preds_with_threshold(rows, scored, t):
        y_pred = []
        for row, s in zip(rows, scored):
            y_pred.append("respond" if s["p"] >= t else s["rest"])
        return y_pred

    def metrics(y_true, y_pred):
        rep = classification_report(y_true, y_pred, labels=LABELS,
                                    digits=4, zero_division=0, output_dict=True)
        return {
            "accuracy": round(float(np.mean(np.asarray(y_pred) ==
                                            np.asarray(y_true))), 4),
            "respond": {k: round(rep["respond"][k], 4)
                        for k in ("precision", "recall", "f1-score")},
            "archive_f1": round(rep["archive"]["f1-score"], 4),
        }

    # --- threshold tuned on VAL (archive-F1 floor), gate never touched ----
    val = val_rows()
    val_scored = prob_rows(val)
    y_val = [r["label"] for r in val]
    chosen_t, chosen_m = None, None
    for t in [i / 100 for i in range(5, 96)]:
        m = metrics(y_val, preds_with_threshold(val, val_scored, t))
        if chosen_m is None:
            chosen_t, chosen_m = t, m
            continue
        guard = m["archive_f1"] >= ARCHIVE_F1_FLOOR
        best_guard = chosen_m["archive_f1"] >= ARCHIVE_F1_FLOOR
        better = m["respond"]["f1-score"] > chosen_m["respond"]["f1-score"]
        if (guard or not best_guard) and (better or (guard and not best_guard)):
            chosen_t, chosen_m = t, m
    argmax_m = metrics(y_val, [s["argmax"] for s in val_scored])
    print(f"chosen threshold: {chosen_t} (val respond F1 "
          f"{chosen_m['respond']['f1-score']}, archive F1 "
          f"{chosen_m['archive_f1']}); argmax-only val F1 "
          f"{argmax_m['respond']['f1-score']}")

    # --- gate: one shot --------------------------------------------------
    gate_ids = set(json.load(open(home() / "data" / "gate_ids.json"))["ids"])
    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    test = sorted((r for r in rows if is_test(r) and r["id"] in gate_ids),
                  key=lambda r: r["d"])
    gate_scored = prob_rows(test)
    y_pred = preds_with_threshold(test, gate_scored, chosen_t)
    y_argmax = [s["argmax"] for s in gate_scored]

    out = {
        "version": "neural-v4-qwen25-15b-lora",
        "base_model": base_path().name,
        "y_pred": y_pred,
        "y_pred_argmax": y_argmax,
        "p_respond": [round(s["p"], 6) for s in gate_scored],
        "ids": [r["id"] for r in test],
        "threshold": chosen_t,
    }
    with open(home() / "artifacts" / "neural-eval-v4.json", "w",
              encoding="utf-8") as fh:
        json.dump(out, fh)

    with open(home() / "artifacts" / "v4-neural-val-probs.json", "w",
              encoding="utf-8") as fh:
        json.dump({
            "ids": [r["id"] for r in val],
            "p_respond": [round(s["p"], 6) for s in val_scored],
            "threshold": chosen_t,
        }, fh)

    z = (np.asarray(y_val) == "respond").astype(float)
    p = np.asarray([s["p"] for s in val_scored])
    bins = []
    for lo in np.linspace(0.0, 0.9, 10):
        mask = (p >= lo) & (p < lo + 0.1)
        if mask.sum():
            bins.append({"bin": f"{lo:.1f}-{lo + 0.1:.1f}",
                         "n": int(mask.sum()),
                         "mean_pred": round(float(p[mask].mean()), 4),
                         "observed": round(float(z[mask].mean()), 4)})

    report = {
        "generated": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat(),
        "base_model": base_path().name,
        "val_rows": len(val),
        "val_counts": {label: y_val.count(label) for label in LABELS},
        "threshold": chosen_t,
        "val_thresholded": chosen_m,
        "val_argmax": argmax_m,
        "reliability_bins_val": bins,
        "note": "threshold tuned on the frozen VAL carve; the gate is "
                "scored once, threshold applied",
    }
    with open(home() / "mine" / "neural-v4-report.json", "w",
              encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"wrote {home() / 'artifacts' / 'neural-eval-v4.json'} "
          f"({len(y_pred)} gate predictions)")
    return 0


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "prep"
    raise SystemExit(
        {"prep": prep, "train": train, "fuse": fuse,
         "eval": evaluate}[stage]())
