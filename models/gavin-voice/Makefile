# gavin-voice: a LoRA fine-tune of Qwen2.5-7B-Instruct that speaks in Gavin's
# voice across channels (email, text, blog), plus a re-runnable eval harness.
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
GAVIN_VOICE_LOCAL ?= /Users/gkline/git-dev/gavin-voice-local
PY := $(GAVIN_VOICE_LOCAL)/venv/bin/python
ADAPTER ?= $(GAVIN_VOICE_LOCAL)/checkpoints/adapter_v1
BASE_MODEL ?= $(GAVIN_VOICE_LOCAL)/models/Qwen2.5-7B-Instruct-4bit
MERGED ?= $(GAVIN_VOICE_LOCAL)/models/gavin-voice-merged
TAG ?= v1

.PHONY: setup bootstrap-key train merge eval judge-help

## Create the (gitignored, outside-repo) venv and download the base model.
setup:
	bash $(MAKEFILE_DIR)scripts/setup_env.sh

## One-time on Gavin's Mac: extract the opencode-go judge key into a local file.
bootstrap-key:
	bash $(MAKEFILE_DIR)scripts/bootstrap_judge_key.sh

## Train the LoRA adapter (renders configs/lora_config.template.yaml).
train:
	bash $(MAKEFILE_DIR)scripts/train.sh

## Fuse base + adapter into a standalone model on disk (never committed).
merge:
	$(PY) -m mlx_lm fuse --model $(BASE_MODEL) \
	    --adapter-path $(ADAPTER) --save-path $(MERGED) --dequantize

## Run the full eval harness (generations, perplexity, judge) and write reports.
eval:
	$(PY) $(MAKEFILE_DIR)evals/eval.py --adapter $(ADAPTER) --tag $(TAG)
