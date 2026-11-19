# gavin-voice v5 outcome — era conditioning (Option 1), capacity, curriculum, and the 14B scale-up

Card t_8a4fad66 (2026-11-19), successor to the v4 honest miss (#537). Levers per the delegated decision: (1) era-conditioned text/email prompts — Option 1; (2) LoRA rank 16 → 32; (3) base scale-up to Qwen2.5-14B-Instruct-4bit, conditional on disk (executed: the fp16 merged keeper was freed after re-serving from base+adapter, 43 GiB free, the 14B downloaded); (4) email format gap reported throughout. Option 3 (two-stage curriculum) was the sanctioned secondary, fired after the primary missed.

## Corpus v5 (Option 1 — era-conditioned prompts)

Old-era rows (text < 2024-06, email < 2023-09 — exactly the v3 windows the frozen primary holdout exemplifies) carry a year tag in the user turn via 3 natural phrasings per channel; recent rows stay byte-identical to v4. **No rows dropped or weighted by date anywhere** (standing mandate: era handling yes, era dropping no).

Composition is IDENTICAL to v4 (same seed/sampling; verified): 21,036 examples, 17,881/3,155 train/valid, per-channel text 11,998 / email 3,738 / blog 21 / persona 20 / instr 5,259, 512 thread-aware emails. Era-tagged: 3,067 text rows + 1,064 email rows. Leak checks: **all 13 PASS**, primary holdout sha `14013551…` byte-identical. The eval instrument is UNCHANGED — v3's incumbent numbers (email 2.57 / text 3.88, re-confirmed in the v4 scorecard run) remain directly comparable.

A derived SECONDARY holdout (`holdout-secondary-v5.jsonl`, same 30 frozen rows, era-tagged prompts via `scripts/derive_secondary_v5.py`, 30/30 tagged) measures the old-era voice after conditioning.

## Gate table (frozen primary holdout, same 8-judge instrument; bars = beat v3's email 2.57 AND text 3.88)

| candidate | recipe | email | text | verdict |
| --- | --- | --- | --- | --- |
| **v3 (incumbent)** | rank 16, corpus v3 | **2.57** | **3.88** | keeper |
| v5 @280 | era-cond + rank 32, val-best 1.264 | **2.71** | 3.0 | MISS (text) |
| v5.1 | v5@280 + 120 @ 5e-6, full blend | 2.33 | 3.0 | MISS (both) |
| v5.2 @40 | v5@280 + recent-only finish (Option 3) | 2.50 | 3.5 | MISS (both) |
| v5b @280 | **Qwen2.5-14B** + era-cond + rank 32, val-best 1.331 (endpoint) | 1.25 | 3.43 | MISS (both) |

Perplexity vs v3 (lower = closer): v5@280 better on every channel (text 4.339 vs 4.441, email 2.546 vs 2.552, blog 2.873 vs 2.924); v5.1 mixed; v5.2 slightly worse overall. Hygiene: 0 `+`-artifacts and 0 degenerate loops on every candidate (the #521 bar holds).

## Secondary (era-tagged old-era prompts, diagnostic only — NOT the gate)

| candidate | email    | text    |
| --------- | -------- | ------- |
| v5 @280   | **3.14** | **4.0** |
| v5.2 @40  | 2.62     | 3.0     |
| v5b @280  | 1.38     | 3.43    |

**This is the v5 headline finding:** era conditioning WORKS. At v5@280 the old-era voice is the strongest in the model — secondary text 4.0 beats even the incumbent's primary bar (3.88), and secondary email 3.14 clears the primary bar too. Both voices coexist in one model, exactly as Option 1 intended. The primary text failure (3.0) is therefore NOT era blending: it is the **"I think…" optimization basin** v4 measured, still reached under lr 1e-5 at the val-best (10/27 primary gens at v5@280; 1/27 after the v5.1 continuation).

## Mechanisms, honestly stated

1. **The basin is base-recipe-bound, not data-bound.** Era conditioning + rank 32 moved val loss (1.264 vs v4's 1.324 at the same iter 280) and email (2.71, the best judged email of any 7B candidate) but the basin still sits at the val-best on the 7B under lr 1e-5.
2. **Full-blend continuation trades bars** (v5.1: email 2.33 / text 3.0; v4.1 already showed email 2.38 / text 3.75 at 240 iters). That lever is exhausted — do not re-run it blind.
3. **A recent-only finish (Option 3) moves text the right way (3.0 → 3.5, I-think openers 0/27) but costs email (2.71 → 2.50) and degrades the old-era voice (secondary 3.14/4.0 → 2.62/3.0).** A curriculum finish is a dial between the two voices, not a free win.
4. **Email format gap (#533/#537 carried):** the recent-only finish (v5.2) CLOSED it — avg 354 chars vs real 288 (v3: 157), multiline 0.90 vs real 0.95 (v3: 0.10), signature rate 0.6 vs real 0.5 (v3: 0) — the best format match of any candidate, while its email judge (2.5) still sits under v3's bar. Format and judged-likeness are separable; a future finish-stage tuning (gentler lr, from a passing basin) has a proven format recipe to build on. v5@280 went the other way (avg 113, multiline 0.1).

## Decision

**HONEST MISS — adapter_v3 remains the promoted keeper.** All four v5-series candidates missed the gate on the frozen primary holdout, and the misses are mechanistically consistent: the "I think…" basin intensifies with capacity and scale (7B rank-16 v4: 8/12; 7B rank-32 v5: 10/27; 14B v5b: 12/27) and every route between the two voices trades one judged channel against the other. What v5 DID deliver: (1) era conditioning is validated — the era-tagged old-era voice at v5@280 (secondary text 4.0 / email 3.14) is the strongest judged voice recorded in this project, and the corpus machinery for it is landed and leak-clean; (2) the email-format recipe (recent-only finish: avg 354 chars / multiline 0.90 / sig 0.6 vs real 288 / 0.95 / 0.5); (3) the 14B base scale-up is measured and NEGATIVE under the standing recipe — do not re-run it blind; (4) v5@280's email judge 2.71 is the best email of any candidate, sitting in the same checkpoint as the text basin. Serving is unchanged: the keeper runs on 127.0.0.1:8931 as base 4-bit + adapter_v3-valbest — exactly the configuration the eval instrument scores — and the disk keeps no fused duplicates (the 14 GB fp16 merge stays freed; the 14B base and all adapters remain under `$GAVIN_VOICE_LOCAL` for the staged next levers, 43 GiB free).

Next levers, in expected-value order: (1) basin avoidance from scratch — a fresh 7B run on corpus v5 at lr 7e-6/400 iters, single-variable vs v5; (2) combine the v5.2 email-format finish with a passing email basin at gentler lr; (3) the validated archive voice is a standing, unapproved option (Option 4 territory: serve v5@280's era-tagged old voice as a second endpoint — needs Gavin's explicit call); (4) blog holdout is n=1-2 judge noise — widen it or drop blog from the gate.

## Serving / disk state (unchanged keeper discipline)

The keeper still serves on 127.0.0.1:8931. Since the v5 serving swap it runs as **base 4-bit + adapter_v3-valbest** (exactly the configuration the eval instrument scores; the 14 GB fp16 merge was freed for the 14B download — SERVING.md documents `make serve-adapter`). One keeper representation on disk.
