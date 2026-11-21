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

### Durable start (LaunchAgents, default since 2026-11-21)

The `make` targets above run in a foreground shell and die with it — which is how the v5-era keeper endpoint silently went down. Both endpoints now run as user LaunchAgents that survive sessions and reboots (`RunAtLoad` + `KeepAlive`), with program args pointing only at `$GAVIN_VOICE_LOCAL` paths (no git-checkout dependency):

| label | port | adapter |
| --- | --- | --- |
| `com.gwkline.gavin-voice` | 8931 | `checkpoints/adapter_v3-valbest` (keeper) |
| `com.gwkline.gavin-voice-archive` | 8932 | `checkpoints/adapter_v5-valbest` (archive voice) |

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gwkline.gavin-voice.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gwkline.gavin-voice-archive.plist
curl -s http://127.0.0.1:8931/health    # both servers log to $GAVIN_VOICE_LOCAL/logs/launchd-<port>.log
```

- Both resident ≈ 12-14 GB RAM. **Pause for a training window**: `launchctl bootout gui/$(id -u)/com.gwkline.gavin-voice{,-archive}` — the next bootstrap (or reboot) brings them back with the adapters on disk.
- A promoted keeper swap needs only a plist edit (`--adapter-path`) + bootout/bootstrap — the make targets remain the ad-hoc/manual path.

## Channel-conditioned generation

The voice is unconditional — no "write like Gavin" system prompt. The channel comes from the user turn, exactly like training. **Omit the `model` field** (or send `"model": "default_model"`) so the server binds its CLI `--adapter-path`:

```sh
curl -s http://127.0.0.1:8931/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "user", "content": "Text Grace that I'\''m running 15 min late."}]}' \
  | jq -r '.choices[0].message.content'
```

> **Adapter-map trap (mlx_lm 0.32.x, measured 2026-11-21):** passing the model id from `/v1/models` as the request's `model` field makes the server look up the adapter by that path, MISS the `default_model` key the CLI adapter is stored under, and answer in the **raw base voice** — health stays 200 and hygiene stays clean, so the failure is invisible to artifact-only checks. The 2026-11-19 v5-swap "live endpoint" smoke hit exactly this trap (its transcript shows base-voice gens) and passed vacuously; the keeper voice was re-verified live with the correct request form on 2026-11-21.

Other channels, same shape: `"Reply to this email thread: \"Re: …\"` (email), `"Write a blog post about: \"…\"` (blog). Era-conditioned training (v5) adds one more: a year tag in the user turn (`It's 2017. Reply to this text from …`) selects the archive-era voice; untagged prompts keep the current voice.

## Smoke tests

2026-11-19, adapter_v3-valbest = iter-200 on corpus v3 (#533), against the fused fp16 model on `127.0.0.1:8931` — full transcript in `$GAVIN_VOICE_LOCAL/samples/serving-smoke-v3.md`:

| channel | prompt | generation (truncated) |
| --- | --- | --- |
| text | `Text Grace that I'm running 15 min late.` | `Oh no! I am so sorry! I will be there in 15 minutes!` |
| email (subject-only) | `Reply to this email thread: "Re: Homelab cluster maintenance window"` | `I think we should probably wait until the 13th to do this. I don't want to do it on the 12th because I have a meeting that day.` |
| email (thread-aware, the #533 serving shape) | `Reply to this email thread: "Re: Komera fundraising check-in"` + quoted incoming | `Hi Cristianna, thanks for the update! I'm going to try to get some more donations in the next week or so. Thanks!` |

Re-verified 2026-11-19 at the v5 serving swap (keeper re-served from base + adapter to free the fp16 merge): offline generation AND the live endpoint, both canonical channels clean — HTTP 200, no `+`-prefix artifacts, no degenerate loops (transcript: `$GAVIN_VOICE_LOCAL/samples/serving-smoke-v5-swap.json`). The v1 `+1000…` defect (#521) remains gone; factual grounding still comes from the prompt. _(Correction 2026-11-21: the live-endpoint leg of that smoke hit the adapter-map trap above — it exercised the raw base. The keeper voice is now verified live with the correct request form; see the two-voice readbacks below.)_

## Two voices (2026-11-20, #540 lever 4, approved)

The v5 honest miss validated era conditioning: the era-tagged old-era voice in v5's val-best adapter is the strongest judged voice recorded in the project (secondary holdout text 4.0 / email 3.14, vs the primary bars 3.88 / 2.57). It is now served as a **second, clearly-labeled endpoint** so the validated voice is actually usable without touching the promote gate:

| endpoint | port | adapter | voice |
| --- | --- | --- | --- |
| **primary keeper** | 8931 | `adapter_v3-valbest` | current-era voice (the gate-scored keeper; untouched) |
| **archive voice** | 8932 | `adapter_v5-valbest` | era-tagged old-era voice via a year tag in the user turn |

```sh
cd models/gavin-voice
make serve-adapter          # primary keeper, 127.0.0.1:8931 (unchanged)
make serve-archive          # archive voice,   127.0.0.1:8932
```

- The archive endpoint answers BOTH forms on its port: an untagged prompt gives v5's current-era voice; a year-tagged prompt (`It's 2017. Reply to this text from …`) selects the old-era archive voice. The label lives in the port + the served adapter — there is no mode switch on 8931.
- Both servers bind `127.0.0.1` only, like the keeper. Running both costs ~12-14 GB RAM.
- Stop either: `lsof -ti :8932 | xargs kill` (8931 likewise).
- If a future gate crowns a new keeper, `make serve-adapter ADAPTER=…/adapter_vN-valbest` moves the primary; the archive endpoint is retired only if the new keeper supersedes the archive voice on the same secondary instrument.

### Two-voice readbacks (2026-11-21, live, correct request form)

Both endpoints up, health 200, `model` field omitted so the CLI adapters bind; full transcript incl. the trap-form control in `$GAVIN_VOICE_LOCAL/samples/serving-smoke-two-voices.json`. All gens: no `+`-prefix artifacts, no degenerate loops.

| endpoint | prompt | generation (truncated) |
| --- | --- | --- |
| 8931 keeper | `Text Grace that I'm running 15 min late.` | `Oh no! I am so sorry! I will be there in 15 minutes!` |
| 8931 keeper | `Reply to this email thread: "Re: lunch this week"` | `I m in!` |
| 8932 archive (era-tagged) | `It's 2017. Reply to this text from Mike: "yo you around this weekend?"` | `I think I m home` |
| 8932 archive (era-tagged) | `Reply to this 2016 email thread: "Re: catching up soon"` | `I think I can make it!` |
| 8932 archive (untagged mode) | `Text the group that practice is moved to 7pm.` | `I think we should move practice to 7pm` |
| 8931 keeper, **trap form** (model id passed) | `Text Grace that I'm running 15 min late.` | `Of course! Here's a graceful way to inform someone…` (raw base — the adapter-map miss) |

## Two-register request convention (2026-11-21, #557 disposition)

The user's stated preference — "On the voice, I actually think I prefer the old one" — is delivered by **serving design**: two registers, selectable per request. Ten gate-evaluated single-adapter candidates (v5 → v9b) never passed both judge bars (closest approach: v9b, email 2.33 / text 4.14 vs the frozen bars 2.57 / 3.88 — [docs/corpus-v9-outcome.md](docs/corpus-v9-outcome.md)), so the old and current voices ship as two endpoints instead of one adapter. The classic register is not a consolation prize: it is the strongest judged voice on record (secondary holdout text 4.0 / email 3.14).

| register | endpoint | adapter | how to request |
| --- | --- | --- | --- |
| **current** (default) | `127.0.0.1:8931` | `adapter_v3-valbest` (keeper) | any prompt — no era tag |
| **classic** (the old voice) | `127.0.0.1:8932` | `adapter_v5-valbest` (archive) | **year tag in the user turn** |

Worked examples per channel — correct request form, `model` field omitted:

| channel | current — 8931, untagged | classic — 8932, year-tagged |
| --- | --- | --- |
| text | `Text Grace that I'm running 15 min late.` → `Oh no! I am so sorry! I will be there in 15 minutes!` | `It's 2017. Reply to this text from Mike: "yo you around this weekend?"` → `I think I m home` |
| email | `Reply to this email thread: "Re: lunch this week"` → `I m in!` | **the old email voice:** `Reply to this 2016 email thread: "Re: catching up soon"` → `I think I can make it!` |
| blog | `Write a blog post about: "…"` | `It's 2017. Write a blog post about: "…"` — see the blog note below |

Precision notes (each is a measured behavior, not a guess):

- **The year tag is the switch, and it exists only on 8932.** Untagged prompts on 8932 give v5's _current-era_ voice, NOT the classic voice. The 8931 keeper was trained without era tags, so a year tag there is ordinary prompt content, not a register switch.
- Years come from the old-era range v5 conditioned on (email pre-2023-09, text pre-2024-06); the recorded canonical legs use 2016 (email) and 2017 (text).
- **Omit the `model` field.** Passing the model id from `/v1/models` answers in the raw base voice with health still 200 — reproduced on demand in the readback below.
- **Blog is weak on both registers, honestly.** The judge instrument measures email and text only; blog has 8–21 training rows ever. The 2026-11-21 live readbacks produced generic essay register on both endpoints (8931 fell into a templated "the importance of …" construction loop). The forms above are the trained shapes; no voice claim is made for blog until the channel gets real corpus depth.

### Register readbacks (2026-11-21, live, both endpoints)

Health 200 on both ports (launchd `com.gwkline.gavin-voice{,-archive}`); full transcript with all gens + hygiene markers at `$GAVIN_VOICE_LOCAL/samples/serving-readback-two-register.json`.

| leg | endpoint / register | verdict |
| --- | --- | --- |
| text, current | 8931 | **MATCH** — byte-identical to the recorded keeper gen |
| email, current | 8931 | **MATCH** |
| text, classic (2017 tag) | 8932 | **MATCH** |
| email, classic (2016 tag) — **the old email voice** | 8932 | **MATCH** |
| blog, current | 8931 | **not voice-evident** — generic essay register, templated loop |
| blog, classic (2017 tag) | 8932 | **not voice-evident** — generic single paragraph |
| trap control — same 8931 text prompt with the `model` id passed | 8931 | **base voice** (`Of course! Here's a graceful way…`) — only the request form differs |

The four canonical legs reproduced byte-identically across three same-day sessions, including after the post-training serving restart — generation is deterministic in practice, so a future `MATCH` readback certifies the CLI adapter bound.
