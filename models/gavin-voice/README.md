# gavin-voice

A LoRA fine-tune of **Qwen2.5-7B-Instruct (4-bit)** that writes in Gavin's voice across channels — email, text, and blog — with a re-runnable eval harness so every future re-train can be graded against a baseline.

> **Privacy invariant:** this repo is public. The raw corpus (Gavin's actual emails, texts, and posts) and generated samples live ONLY under `$GAVIN_VOICE_LOCAL` (`~/git-dev/gavin-voice-local`), outside the repo, and the `.gitignore` entries in this PR keep it that way. Only code, configs, the small LoRA adapter, and aggregate metrics are committed.

## Layout

```
models/gavin-voice/
├── README.md                     ← you are here
├── Makefile                      ← setup / train / merge / eval
├── configs/lora_config.template.yaml
├── adapters/adapter_v1/          ← the trained LoRA adapter (committed)
├── scripts/
│   ├── setup_env.sh              ← venv (uv, python 3.12) + base model download
│   ├── extract_texts.py          ← chat.db texts (streamtyped blobs)
│   ├── docs/extract-gmail-sent.ts.md ← Gmail Sent sandbox snippet (Executor MCP)
│   ├── extract_texts.py          ← chat.db texts (streamtyped blobs)
│   ├── docs/extract-gmail-sent.ts.md ← Gmail Sent sandbox snippet (Executor MCP)
│   ├── extract_blog.py           ← gwkline/personal-site content
│   ├── build_corpus.py           ← clean/dedupe → channels → train/valid/holdout
│   ├── train.sh                  ← render config → mlx_lm.lora
│   └── bootstrap_judge_key.sh    ← opencode-go judge key (Gavin's Mac only)
└── evals/
    ├── eval.py                   ← one-command harness (make eval)
    ├── judge.py                  ← glm-5.3 style judge via opencode-go
    └── results/baseline-v1.json  ← aggregate-only baseline scores
```

Everything heavy or personal is written to `$GAVIN_VOICE_LOCAL` (default `/Users/gkline/git-dev/gavin-voice-local`): `corpus/`, `data/`, `checkpoints/`, `samples/`, `evals/` outputs, the downloaded base model, the venv, and the merged full model (`models/gavin-voice-merged`, produced by `make merge`).

## Corpus (Phase 1)

| Channel | Source | Kept | Notes |
| --- | --- | --- | --- |
| email | Gmail Sent (501 fetched) | 326 | auto-unsubscribes/calendar noise dropped; quoted replies stripped |
| text | `chat.db`, Jun 2024→ | 17,947 bursts / 349 chats | streamtyped `attributedBody` decoded; his consecutive messages merged into bursts; ~3k sampled for training |
| blog | personal-site posts + project pages | 10 docs | split into ~2.8k-char chunks |
| tweet | — | 0 | no local X/Twitter archive export existed; see follow-up issue |

Stats live in `$GAVIN_VOICE_LOCAL/corpus/stats.json`.

### Training-data design (the pirate-LoRA lessons, as requirements)

1. **Unconditional voice.** Every training example appears twice: with the generic system prompt `"You are a helpful assistant."` and with no system prompt at all. There is never a "write like Gavin" prompt — the style must survive any framing.
2. **Channel conditioning in the user turn.** e.g. `Reply to this email thread: "Re: …"` / `Reply to this text from Grace: "…"` / `Write a blog post about: "…"`, with 3–4 phrasing variants per channel so the model doesn't key on a template.
3. **Held-out eval.** 20 emails, 60 texts, 1 project writeup (+5 task-style probes like "Text Grace that I'm running 15 min late") never see training.
4. **512–1024-token sequences** so full emails hold coherence (`max_seq_length: 1024`).
5. General instruction data was NOT mixed in v1 (corpus is text-dominated); tracked as a follow-up if the model ever degrades on plain assistant tasks.

## Training (Phase 2)

`make train` → `mlx_lm.lora` LoRA on the 4-bit base:

- rank 16, scale 16 (alpha = 2 x rank's worth of effective step at lr 1e-5)
- LoRA on all attention + MLP projections (q,k,v,o,gate,up,down) of the last 16 of 28 blocks → 23.1M trainable params (0.30%)
- lr 1e-5, batch 4, max seq 512 (in the 512–1024 spec band), `--mask-prompt` (loss on assistant tokens only), 160 iters, val every 40, save-every 40
- **NaN warning:** LoRA on the 4-bit base went NaN twice — lr 1e-4/scale 32/all layers at iter 40, and lr 5e-5/scale 16 with `grad_checkpoint: true` at iter 60. The stable recipe is lr 1e-5 with `grad_checkpoint: false`; both failures are recorded in the config template so they aren't retried blind.
- val loss: 9.43 (base) → ~2.9 by iter 40; ~34 padded tok/s on the M3 Pro (36 GB); checkpoints in `$GAVIN_VOICE_LOCAL/checkpoints/adapter_v1` every 40 iters make an interrupted run resumable via `--resume-adapter-file`

**Why 7B:** memory was never the constraint on this machine (the 4-bit base is ~4.3 GB resident); throughput was the only cost, and a budget run is feasible at seq 512. If future corpora grow 5×, drop to `Qwen2.5-3B-Instruct-4bit` (same scripts, ~3× faster) and re-baseline.

Run the adapter directly with the 4-bit base:

```sh
$GAVIN_VOICE_LOCAL/venv/bin/mlx_lm.generate \
  --model $GAVIN_VOICE_LOCAL/models/Qwen2.5-7B-Instruct-4bit \
  --adapter-path adapters/adapter_v1 \
  --max-tokens 200 --prompt "Text Grace that I'm running 15 min late."
```

## Eval harness (Phase 3)

`make eval` (or `evals/eval.py --adapter … --tag vX`) does three things and writes `results.json` + a readable `report.md` under `$GAVIN_VOICE_LOCAL/evals/results-<tag>/`:

1. **Generations** on held-out prompts per channel with the fine-tune AND the base model (no system prompt — measuring the unconditional voice).
2. **Automatic scores:** perplexity of held-out real text; length/format distribution match (avg chars, signature rate, multiline rate, exclamations) vs real messages.
3. **LLM judge:** glm-5.3 via opencode-go rates each generation 1–5 on "does this sound like Gavin" against three real exemplars per channel. Auth: `OPENCODE_GO_API_KEY` (on Gavin's Mac, `make bootstrap-key` extracts it from the local agent environment into a mode-600 file outside the repo).

With `--commit`, an aggregate-only baseline (`evals/results/baseline-<tag>.json`) is written into the repo — scores and counts only, never sample text — so each re-train is diffable against v1.

## Rebuild / re-train from scratch

```sh
make setup                       # venv + base model
# corpus: run docs/extract-gmail-sent.ts.md via Executor MCP into
#   $GAVIN_VOICE_LOCAL/corpus/email_batches/ (batches of ~100 ids),
#   then: scripts/extract_texts.py && scripts/extract_blog.py && scripts/build_corpus.py
make train                       # ~45 min on the M3 Pro
make eval TAG=v2                 # judge + perplexity + report
```
