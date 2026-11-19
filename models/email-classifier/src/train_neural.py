"""Neural candidate: Qwen2.5-0.5B-Instruct + LoRA, 3-way action classification.

Runs in the durable dir's MLX venv (.venv-mlx — mlx-lm is not part of the
serving requirements). Stages, via argv[1]:

  prep    build artifacts/neural-data/{train,valid}.jsonl in mlx-lm chat
          format from the SAME labeled data + standing split the classical
          pipeline uses (respond oversampled 3x, mark-read 8x; validation is
          the newest 15% of TRAIN rows, never the held-out test set)
  train   LoRA fine-tune via the mlx_lm.lora CLI, then fuse the adapter
  eval    score every held-out test row by comparing summed label-token
          log-probs; writes artifacts/neural-eval.json for the scorecard

The prompt is intentionally the same information the classical model gets
(From / Subject / snippet) so the scorecard compares model classes, not
feature sets.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from common import home, is_test, is_train, labeled_path

BASE_MODEL = "qwen25-05b-instruct"
PROMPT = (
    "Predict the one action Gavin takes on this email: respond, archive, or "
    "mark-read. Answer with exactly one word, nothing else.\n\n"
    "From: {f}\nSubject: {s}\nBody: {n}"
)
OVERSAMPLE = {"respond": 3, "mark-read": 8}


def data_dir() -> Path:
    return home() / "artifacts" / "neural-data"


def adapter_path() -> Path:
    return home() / "artifacts" / "neural-adapter"


def fused_path() -> Path:
    return home() / "artifacts" / "neural-fused"


def prep() -> int:
    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    train = [r for r in rows if is_train(r)]
    # validation = newest 15% of TRAIN (leak-free; standing test untouched)
    train_sorted = sorted(train, key=lambda r: r["d"])
    cut = int(len(train_sorted) * 0.85)
    valid, fit = train_sorted[cut:], train_sorted[:cut]

    out = data_dir()
    out.mkdir(parents=True, exist_ok=True)

    def chat(row):
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

    with open(out / "train.jsonl", "w", encoding="utf-8") as fh:
        for r in fit:
            for _ in range(OVERSAMPLE.get(r["label"], 1)):
                fh.write(json.dumps(chat(r)) + "\n")
    with open(out / "valid.jsonl", "w", encoding="utf-8") as fh:
        for r in valid:
            fh.write(json.dumps(chat(r)) + "\n")
    n_train = sum(OVERSAMPLE.get(r["label"], 1) for r in fit)
    print(f"train rows (oversampled): {n_train}, valid rows: {len(valid)}")
    return 0


def train() -> int:
    iters = int(os.environ.get("NEURAL_ITERS", "800"))
    common = [
        sys.executable,
        "-m",
        "mlx_lm",
        "lora",
        "--model",
        str(home() / "artifacts" / BASE_MODEL),
        "--train",
        "--data",
        str(data_dir()),
        "--fine-tune-type",
        "lora",
        "--num-layers",
        "8",
        "--batch-size",
        "8",
        "--iters",
        str(iters),
        "--learning-rate",
        "1e-4",
        "--mask-prompt",
        "--max-seq-length",
        "384",
        "--adapter-path",
        str(adapter_path()),
    ]
    print(" ".join(common), flush=True)
    subprocess.run(common, check=True)
    fuse = [
        sys.executable,
        "-m",
        "mlx_lm",
        "fuse",
        "--model",
        str(home() / "artifacts" / BASE_MODEL),
        "--adapter-path",
        str(adapter_path()),
        "--save-path",
        str(fused_path()),
    ]
    print(" ".join(fuse), flush=True)
    subprocess.run(fuse, check=True)
    return 0


def evaluate() -> int:
    import mlx.core as mx
    from mlx_lm import load
    from transformers import AutoTokenizer

    model, _tok = load(str(fused_path()))
    tok = AutoTokenizer.from_pretrained(str(fused_path()))

    rows = [json.loads(line) for line in open(labeled_path(), encoding="utf-8")]
    test = sorted([r for r in rows if is_test(r)], key=lambda r: r["d"])
    labels = ["respond", "archive", "mark-read"]

    def prompt_for(row):
        messages = [
            {
                "role": "user",
                "content": PROMPT.format(
                    f=row["from"], s=row["subject"], n=row["snippet"]
                ),
            }
        ]
        return tok.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

    y_pred = []
    for row in test:
        text = prompt_for(row)
        ids_prompt = tok.encode(text, add_special_tokens=False)
        scores = {}
        for label in labels:
            ids_label = tok.encode(label, add_special_tokens=False)
            ids = mx.array([ids_prompt + ids_label])
            logits = model(ids)
            logprobs = mx.log_softmax(logits[0].astype(mx.float32))
            total = 0.0
            for k, t in enumerate(ids_label):
                total += float(logprobs[len(ids_prompt) + k - 1, t])
            scores[label] = total
        best = max(scores.items(), key=lambda kv: kv[1])[0]
        y_pred.append(best)

    out = {
        "version": "neural-qwen25-05b-lora",
        "y_pred": y_pred,
        "ids": [r["id"] for r in test],
        "model": BASE_MODEL,
    }
    path = home() / "artifacts" / "neural-eval.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print(f"wrote {path}: {len(y_pred)} predictions")
    return 0


if __name__ == "__main__":
    stage = sys.argv[1] if len(sys.argv) > 1 else "prep"
    raise SystemExit({"prep": prep, "train": train, "eval": evaluate}[stage]())
