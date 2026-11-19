#!/bin/bash
# gavin-voice environment setup: dedicated venv + 4-bit base model download.
# Everything lands under $GAVIN_VOICE_LOCAL (outside the repo, gitignored by
# design — the repo clone only carries code + adapter).
set -euo pipefail

GAVIN_VOICE_LOCAL="${GAVIN_VOICE_LOCAL:-/Users/gkline/git-dev/gavin-voice-local}"
BASE_MODEL="${BASE_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit}"

mkdir -p "$GAVIN_VOICE_LOCAL"/{corpus,data,checkpoints,samples,evals,models,logs,config}

# The system python may be too new for mlx — use uv to pin 3.12.
if [ ! -x "$GAVIN_VOICE_LOCAL/venv/bin/python" ]; then
  uv venv --python 3.12 "$GAVIN_VOICE_LOCAL/venv"
fi
uv pip install --python "$GAVIN_VOICE_LOCAL/venv/bin/python" mlx mlx-lm

"$GAVIN_VOICE_LOCAL/venv/bin/python" - <<'EOF'
import mlx.core as mx, mlx_lm
print("mlx-lm", mlx_lm.__version__, "ready")
EOF

MODEL_DIR="$GAVIN_VOICE_LOCAL/models/$(basename "$BASE_MODEL")"
if [ ! -f "$MODEL_DIR/model.safetensors" ]; then
  "$GAVIN_VOICE_LOCAL/venv/bin/hf" download "$BASE_MODEL" --local-dir "$MODEL_DIR" \
    || "$GAVIN_VOICE_LOCAL/venv/bin/huggingface-cli" download "$BASE_MODEL" --local-dir "$MODEL_DIR"
fi
echo "setup complete: venv + model at $MODEL_DIR"
