# gavin-voice serving endpoint

A local, OpenAI-compatible HTTP endpoint for the merged fine-tuned model.
**Mac-local only**: the server binds to `127.0.0.1` — no LAN, no tailnet
ingress (that would be a separate issue), no public exposure.

## Model

`$GAVIN_VOICE_LOCAL/models/gavin-voice-merged-v2` — the Qwen2.5-7B base
fused with the `adapter_v2` LoRA (`make merge`, fp16 dequantized, ~15 GB on
disk, never committed). If a future eval crowns a different adapter the
winner, `make merge MERGED=...-vN` + `make serve` picks it up.

## Start

```sh
cd models/gavin-voice
make serve                 # = mlx_lm.server --model $GAVIN_VOICE_LOCAL/models/gavin-voice-merged-v2 \
                           #   --host 127.0.0.1 --port 8931
# first request takes ~30-60 s while the ~15 GB model loads into memory
```

- Endpoint: `http://127.0.0.1:8931/v1/chat/completions` (also `/v1/completions`, `/v1/models`)
- RAM: ~15-16 GB resident while serving — close other big jobs first.
- Stop: `Ctrl-C` (or `lsof -ti :8931 | xargs kill`).

## Channel-conditioned generation

The voice is unconditional — no "write like Gavin" system prompt. The channel
comes from the user turn, exactly like training. NOTE: the request's `model`
field must be the model id the server loaded (the local path) — grab it from
`/v1/models`:

```sh
curl -s http://127.0.0.1:8931/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "'"$(curl -s http://127.0.0.1:8931/v1/models | jq -r '.data[0].id')"'",
       "messages": [{"role": "user", "content": "Text Grace that I'\''m running 15 min late."}]}' \
  | jq -r '.choices[0].message.content'
```

Other channels, same shape: `"Reply to this email thread: \"Re: …\"` (email),
`"Write a blog post about: \"…\"` (blog).

## Smoke test (2026-11-19, adapter_v2)

<!-- transcript appended after the live run; see samples/serving-smoke-v2.md locally for full outputs -->
