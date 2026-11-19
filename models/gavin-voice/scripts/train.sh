#!/bin/bash
# Render the LoRA config template with $GAVIN_VOICE_LOCAL and launch mlx-lm
# LoRA training. Checkpoints are saved under $GAVIN_VOICE_LOCAL/checkpoints
# so a killed run can resume (--resume-adapter-file) or be picked up as-is.
set -euo pipefail

GAVIN_VOICE_LOCAL="${GAVIN_VOICE_LOCAL:-/Users/gkline/git-dev/gavin-voice-local}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="${ADAPTER:-$GAVIN_VOICE_LOCAL/checkpoints/adapter_v1}"

mkdir -p "$GAVIN_VOICE_LOCAL/config" "$ADAPTER"
sed "s|__GAVIN_VOICE_LOCAL__|$GAVIN_VOICE_LOCAL|g" \
  "$HERE/configs/lora_config.template.yaml" > "$GAVIN_VOICE_LOCAL/config/lora_config.yaml"

cd "$GAVIN_VOICE_LOCAL"
exec ./venv/bin/mlx_lm.lora -c config/lora_config.yaml --train \
  --adapter-path "$ADAPTER" 2>&1 | tee -a "$GAVIN_VOICE_LOCAL/logs/train.log"
