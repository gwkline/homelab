# gavin-voice: a LoRA fine-tune of Qwen2.5-7B-Instruct that speaks in Gavin's
# voice across channels (email, text, blog), plus a re-runnable eval harness.
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
GAVIN_VOICE_LOCAL ?= /Users/gkline/git-dev/gavin-voice-local
PY := $(GAVIN_VOICE_LOCAL)/venv/bin/python
HF := $(GAVIN_VOICE_LOCAL)/venv/bin/hf
ADAPTER ?= $(GAVIN_VOICE_LOCAL)/checkpoints/adapter_v3-valbest
ARCHIVE_ADAPTER ?= $(GAVIN_VOICE_LOCAL)/checkpoints/adapter_v5-valbest
BASE_MODEL ?= $(GAVIN_VOICE_LOCAL)/models/Qwen2.5-7B-Instruct-4bit
MERGED ?= $(GAVIN_VOICE_LOCAL)/models/gavin-voice-merged-v3
TAG ?= v2
PORT ?= 8931
ARCHIVE_PORT ?= 8932

.PHONY: setup bootstrap-key instructions train merge eval serve serve-archive

## Create the (gitignored, outside-repo) venv and download the base model.
setup:
	bash $(MAKEFILE_DIR)scripts/setup_env.sh

## One-time on Gavin's Mac: extract the opencode-go judge key into a local file.
bootstrap-key:
	bash $(MAKEFILE_DIR)scripts/bootstrap_judge_key.sh

## Download alpaca-cleaned and render the instruction mix (#511, ~25% of train).
instructions:
	$(HF) download yahma/alpaca-cleaned --repo-type dataset \
	    --local-dir $(GAVIN_VOICE_LOCAL)/data/external/alpaca-cleaned
	$(PY) $(MAKEFILE_DIR)scripts/mix_instructions.py

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

## Serve the merged model as a local OpenAI-compatible API (see SERVING.md).
serve:
	$(PY) -m mlx_lm.server --model $(MERGED) --host 127.0.0.1 --port $(PORT)

## Serve the keeper from base + adapter (the v5 default mode: this is the
## configuration the eval instrument scores, and it keeps only one keeper
## representation on disk — no 14 GB fp16 merge; see SERVING.md).
serve-adapter:
	$(PY) -m mlx_lm.server --model $(BASE_MODEL) --adapter-path $(ADAPTER) \
	  --host 127.0.0.1 --port $(PORT)

## Serve the era-tagged ARCHIVE voice as a clearly-labeled SECOND endpoint
## (#540 lever 4, approved 2026-11-20): v5's val-best adapter, whose
## era-tagged old voice is the strongest judged voice in the project
## (secondary text 4.0 / email 3.14). The primary keeper on $(PORT) stays
## untouched; see SERVING.md "Two voices".
serve-archive:
	$(PY) -m mlx_lm.server --model $(BASE_MODEL) --adapter-path $(ARCHIVE_ADAPTER) \
	  --host 127.0.0.1 --port $(ARCHIVE_PORT)
