#!/usr/bin/env python3
"""Render the (public-safe) PR body from aggregate eval results — no sample
text, no personal data; side-by-side samples stay in the durable report."""
import json, sys

r = json.load(open(sys.argv[1]))

def row(ch):
    j_b = r["judge"].get("base", {}).get(ch, "–")
    j_f = r["judge"].get("ft", {}).get(ch, "–")
    p_b = r["perplexity"]["base"].get(ch, "–")
    p_f = r["perplexity"]["ft"].get(ch, "–")
    return f"| {ch} | {j_b} | {j_f} | {p_b} | {p_f} |"

judge_rows = "\n".join(row(ch) for ch in ("email", "text", "blog"))
overall = f"| overall | – | – | {r['perplexity']['base']['overall']} | {r['perplexity']['ft']['overall']} |"

body = f"""## What

`models/gavin-voice/`: a LoRA fine-tune of **Qwen2.5-7B-Instruct (4-bit)** that writes in Gavin's voice across email / text / blog channels, plus the corpus builders and a one-command eval harness (`make eval`) so every future re-train can be graded against a committed baseline.

## Privacy invariant

The repo is public; the corpus and generations are not. Raw channels, checkpoints, samples and eval outputs live only under `$GAVIN_VOICE_LOCAL` (`~/git-dev/gavin-voice-local`, outside the repo), and `.gitignore` entries are defense-in-depth. Committed: code, configs, the 46 MB fp16 adapter, aggregate metrics only. Verified locally with `gitleaks detect` (no findings).

## Corpus (Phase 1)

| channel | source | kept |
|---|---|---|
| email | Gmail Sent via Executor MCP (501 fetched) | 326 (auto/calendar noise dropped, quotes stripped) |
| text | `~/Library/Messages/chat.db` since 2024-06 (103k rows) | 17,947 bursts / 342 chats (streamtyped attributedBody decoded) |
| blog | `gwkline/personal-site` | 10 docs → 8 chunks |
| tweets | — | skipped: no local X/Twitter archive ({'#'}510) |

Training data: 6,624 examples (every example twice — generic system prompt AND no system prompt, so the voice is unconditional; channel conditioning in the user turn, 3-4 phrasing variants; 15% validation; 81 held-out eval prompts).

## Training (Phase 2)

`mlx_lm.lora`, rank 16 / scale 16 on all attention+MLP projections of the last 16 of 28 blocks (23.1M params, 0.30%), lr 1e-5, seq 512, mask-prompt, 160 iters (~35 padded tok/s on the M3 Pro). Val 9.43 → ~2.97 (iter 40). Two NaN failure modes on the 4-bit base are recorded in the config template so they aren't retried blind (lr 1e-4/scale 32/all-layers; lr 5e-5 + grad-checkpoint).

## Eval baseline (Phase 3)

`make eval` → held-out generations with fine-tune vs base (no system prompt), perplexity on held-out real text, length/format distribution match, and a glm-5.3 LLM judge (via opencode-go) rating "does this sound like Gavin" 1–5 against three real exemplars per channel.

| channel | judge: base | judge: ft | ppl: base | ppl: ft |
|---|---|---|---|---|
{judge_rows}
{overall}

(Aggregates only — full side-by-side samples + markdown report stay in `$GAVIN_VOICE_LOCAL/evals/results-v1/report.md`.)

## Re-run

```sh
make setup && make train && make eval TAG=v2   # re-baseline and diff
```

## Follow-ups

- {'#'}510 tweets channel once an X archive exists
- {'#'}511 mix ~20-30% general instruction data
- {'#'}512 stronger adapter run (seq 1024, 600 iters, 8-bit/fp16 base)
- {'#'}513 automated eval sweep + baseline diff after every re-train

No cluster/deploy inputs changed — no manual apply needed; `ci` should only run the standard checks for an app-untouched change.
"""
open(sys.argv[2], "w").write(body)
print("wrote", sys.argv[2])
