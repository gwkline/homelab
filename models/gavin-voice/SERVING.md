# gavin-voice serving endpoint

A local, OpenAI-compatible HTTP endpoint for the fine-tuned model. **Mac-local only**: the server binds to `127.0.0.1` — no LAN, no tailnet ingress (that would be a separate issue), no public exposure.

## Model

The keeper serves from **base + adapter**: `Qwen2.5-7B-Instruct-4bit` with the promoted LoRA applied at load time (`make serve-adapter`). As of v5 (2026-11-19) this is the default mode, for two reasons:

- **It is exactly the configuration the eval instrument scores** — `evals/eval.py` loads the 4-bit base with `--adapter-path`, so the served model and the gate numbers are the same model.
- **Disk**: a fused fp16 merge is ~14 GB; v5's base scale-up lever freed it (room for the Qwen2.5-14B base download) so exactly one keeper representation stays on disk. A fused model remains available when wanted — `make merge MERGED=...-vN` + `make serve`, and prefer a fused **4-bit** (`mlx_lm fuse` without `--dequantize`) when the fp16 doesn't fit.

If a future eval crowns a different adapter the winner, `make serve-adapter ADAPTER=$GAVIN_VOICE_LOCAL/checkpoints/adapter_vN-valbest` picks it up; a different base, add `BASE_MODEL=…`.

## Start

```sh
cd models/gavin-voice
make serve-adapter          # = mlx_lm.server --model …/Qwen2.5-7B-Instruct-4bit \
                             #   --adapter-path …/checkpoints/adapter_v3-valbest \
                             #   --host 127.0.0.1 --port 8931
# first request takes ~10-20 s while the 4-bit base + adapter load
```

- Endpoint: `http://127.0.0.1:8931/v1/chat/completions` (also `/v1/completions`, `/v1/models`)
- RAM: ~6-7 GB resident while serving.
- Stop: `Ctrl-C` (or `lsof -ti :8931 | xargs kill`).

## Channel-conditioned generation

The voice is unconditional — no "write like Gavin" system prompt. The channel comes from the user turn, exactly like training. NOTE: the request's `model` field must be the model id the server loaded (the local path) — grab it from `/v1/models`:

```sh
curl -s http://127.0.0.1:8931/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "'"$(curl -s http://127.0.0.1:8931/v1/models | jq -r '.data[0].id')"'",
       "messages": [{"role": "user", "content": "Text Grace that I'\''m running 15 min late."}]}' \
  | jq -r '.choices[0].message.content'
```

Other channels, same shape: `"Reply to this email thread: \"Re: …\"` (email), `"Write a blog post about: \"…\"` (blog). Era-conditioned training (v5) adds one more: a year tag in the user turn (`It's 2017. Reply to this text from …`) selects the archive-era voice; untagged prompts keep the current voice.

## Smoke tests

2026-11-19, adapter_v3-valbest = iter-200 on corpus v3 (#533), against the fused fp16 model on `127.0.0.1:8931` — full transcript in `$GAVIN_VOICE_LOCAL/samples/serving-smoke-v3.md`:

| channel | prompt | generation (truncated) |
| --- | --- | --- |
| text | `Text Grace that I'm running 15 min late.` | `Oh no! I am so sorry! I will be there in 15 minutes!` |
| email (subject-only) | `Reply to this email thread: "Re: Homelab cluster maintenance window"` | `I think we should probably wait until the 13th to do this. I don't want to do it on the 12th because I have a meeting that day.` |
| email (thread-aware, the #533 serving shape) | `Reply to this email thread: "Re: Komera fundraising check-in"` + quoted incoming | `Hi Cristianna, thanks for the update! I'm going to try to get some more donations in the next week or so. Thanks!` |

Re-verified 2026-11-19 at the v5 serving swap (keeper re-served from base + adapter to free the fp16 merge): offline generation AND the live endpoint, both canonical channels clean — HTTP 200, no `+`-prefix artifacts, no degenerate loops (transcript: `$GAVIN_VOICE_LOCAL/samples/serving-smoke-v5-swap.json`). The v1 `+1000…` defect (#521) remains gone; factual grounding still comes from the prompt.
