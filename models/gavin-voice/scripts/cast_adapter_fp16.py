#!/usr/bin/env python3
"""Cast a LoRA adapter's parameters to fp16 on disk (halves size) — the saved
dtype is fp32 in mlx-lm, which would push a 16-layer/7B adapter past GitHub's
100MB per-file limit."""
import json, sys
import mlx.core as mx
from mlx.utils import tree_flatten, tree_unflatten

src, dst = sys.argv[1], sys.argv[2]
weights = mx.load(f"{src}/adapters.safetensors")
flat = [(k, v.astype(mx.float16)) for k, v in tree_flatten(weights)]
mx.save_safetensors(f"{dst}/adapters.safetensors", dict(flat),
                     metadata={"format": "mlx"})
import shutil, os
for extra in ("adapter_config.json",):
    if os.path.exists(f"{src}/{extra}"):
        shutil.copy(f"{src}/{extra}", f"{dst}/{extra}")
print("wrote fp16 adapter to", dst)
