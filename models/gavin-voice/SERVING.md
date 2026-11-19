# gavin-voice serving endpoint

A local, OpenAI-compatible HTTP endpoint for the merged fine-tuned model. **Mac-local only**: the server binds to `127.0.0.1` — no LAN, no tailnet ingress (that would be a separate issue), no public exposure.

## Model

`$GAVIN_VOICE_LOCAL/models/gavin-voice-merged-v3` — the Qwen2.5-7B base fused with the `adapter_v3-valbest` LoRA (iter-200 val-best 1.436 on corpus v3, issue #533: thread-aware email prompts + persona facts; `make merge`, fp16 dequantized, ~15 GB on disk, never committed). If a future eval crowns a different adapter the winner, `make merge MERGED=...-vN` + `make serve` picks it up.

## Start

```sh
cd models/gavin-voice
make serve                 # = mlx_lm.server --model $GAVIN_VOICE_LOCAL/models/gavin-voice-merged-v3 \
                           #   --host 127.0.0.1 --port 8931
# first request takes ~30-60 s while the ~15 GB model loads into memory
```

- Endpoint: `http://127.0.0.1:8931/v1/chat/completions` (also `/v1/completions`, `/v1/models`)
- RAM: ~15-16 GB resident while serving — close other big jobs first.
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

Other channels, same shape: `"Reply to this email thread: \"Re: …\"` (email), `"Write a blog post about: \"…\"` (blog).

## Smoke test (2026-11-19, adapter_v3-valbest = iter-200 on corpus v3, #533)

Run live against the fused fp16 model on `127.0.0.1:8931`:

| channel | prompt | generation (truncated; full transcript in `$GAVIN_VOICE_LOCAL/samples/serving-smoke-v3.md`) |
| --- | --- | --- |
| text | `Text Grace that I'm running 15 min late.` | `Oh no! I am so sorry! I will be there in 15 minutes!` |
| email (subject-only) | `Reply to this email thread: "Re: Homelab cluster maintenance window"` | `I think we should probably wait until the 13th to do this. I don't want to do it on the 12th because I have a meeting that day.` |
| email (thread-aware, the #533 serving shape) | `Reply to this email thread: "Re: Komera fundraising check-in"` + Cristianna's quoted message ($420 of the $960 commitment) | `Hi Cristianna, thanks for the update! I'm going to try to get some more donations in the next week or so. Thanks!` |

No `+`-prefix artifacts, no degenerate loops. The subject-only email stays conservative (no invented roles/credentials — the v2.1 failure mode); the thread-aware prompt replies to the ACTUAL content, which is the intended v3 serving shape: quote the incoming message in the user turn for a grounded reply.
