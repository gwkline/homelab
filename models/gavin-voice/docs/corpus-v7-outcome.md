# gavin-voice v7 outcome — capacity×data factorization (#548): the 2×2 map is complete

Card t_5930951e (2026-11-21), successor to the v6 lr-invariance miss (#540). Mandate: "do whatever you think will improve our scores the most… I want these to be fucking excellent models." The last two untested cells of the capacity×data grid were run as single-variable moves vs the v6 baseline (shared recipe: Qwen2.5-7B-Instruct-4bit, lr 7e-6, 400 iters, batch 2 / seq 1024, last-16 blocks, seed 42, save/val every 40, val-best promotion):

- **CORNER A — rank16×corpus-v5** (`lora_config_v7a.yaml`): does LOWER capacity tame the "I think…" basin on the full-history corpus?
- **CORNER B — rank32×corpus-v3** (`lora_config_v7b.yaml`): does MORE capacity lift the keeper's clean thread-aware corpus past its own bars?

**Outcome: both corners MISS — the 2×2 is complete, adapter_v3 remains the keeper, and the capacity×data lane is closed.** Both corners landed on the SAME judge scores (email 1.62 / text 3.38) from opposite corners of the grid, and neither mechanism the corners were designed to test rescued a bar.

## The completed capacity×data map (frozen primary holdout sha `14013551…`, same 8-judge glm-5.3 instrument)

| cell | recipe | email | text | basin @ val-best (probe / primary gens) | ppl email / text / overall | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **rank16 × corpus v3** | v3 incumbent (lr 1e-5, 240) | **2.57** | **3.88** | 2/8 probe / 0-2 of 27 | 2.5521 / 4.4408 / 3.5676 | **KEEPER** |
| rank32 × corpus v5 | v5/v6 family, 6 candidates | best 2.75 (v6@280) | best 3.5 (v5.2 finish) | 0.375 / 10 of 27 (v6@280) | mixed; email-best 2.546 | closed (#540/#537) |
| **corner A: rank16 × corpus v5** | v7a val-best iter 280 @ 1.367 | 1.62 | 3.38 | **0.375 probe (peak 0.5 @240) / 9 of 27** | 2.6138 / 4.3605 / 3.5512 | **MISS both** |
| **corner B: rank32 × corpus v3** | v7b val-best iter 200 @ 1.431 | 1.62 | 3.38 | **0.25 probe / 2 of 27 (control level)** | 2.5332 / 4.4264 / 3.5517 | **MISS both** |

Incumbent re-run on the same instrument, same adapter, same day: email 2.14 / text 3.88 / blog 1.2, I-think 2/27, hygiene clean, ppl **byte-identical** to the recorded values (2.5521 / 4.4408 / 3.5676 — the ppl path is deterministic). Text reproduces exactly; the email point sits 0.43 under the recorded bar, inside the ±0.5-at-n=8 judge noise band the v3 instrument widening documented. The frozen recorded bars (2.57 / 3.88) stand; the re-run makes them conservative, not softer.

Hygiene: 0 `+`-artifacts and 0 degenerate loops on both corners (the #521 bar holds). Both runs NaN-free at lr 7e-6 to 400 iters (third consecutive confirmation). Corner A's email ppl is the only channel-worse ppl on either corner; corner B's blog ppl misses by 0.0039.

## Basin curves (scripts/basin_probe.py, 8 neutral greedy prompts; controls re-probed pre-train: base 0/8, v3 incumbent 2/8 — identical to the v6 calibration)

- **v7a (rank16×v5):** 0.0 / 0.25 / 0.0 / 0.0 / 0.125 / **0.5** / 0.375 / 0.375 / 0.25 / 0.125 (iters 40→400). Abort signature (≥0.625 on two consecutive checkpoints) never fired; the val-best sits in the same 0.375 pocket as v6's.
- **v7b (rank32×v3):** 0.0 / 0.0 / 0.0 / 0.125 / 0.25 / 0.125 / 0.125 / 0.375 / 0.375 / 0.125. Val-best @200 is control-level (0.25 probe, 2/27 primary gens); a mild late-run bump at 320/360 never reaches the val-best region.
- **The abort decision: no abort on either run** — the flag never fired; both runs completed and were evaluated as trained. (Mid-run probing ran only at iter 40 for v7a before being moved post-hoc: with both live endpoints resident, a probe load takes ~15 min under GPU contention vs ~30 s idle — v6 trained with no endpoints up, so its mid-run cadence doesn't transfer. Curves were swept sequentially after each training run; same checkpoints, same instrument.)

## Mechanisms, honestly stated

1. **The basin is corpus-bound, not capacity-bound.** The v5-era hypothesis ("intensifies with rank 8/12 → 10/27") is refuted at the val optimum: on corpus v5 the basin sits at the val-best at rank 16 exactly as at rank 32 (probe 0.375, 9 vs 10 of 27 primary openers) and at both lrs; on corpus v3 it is absent at BOTH ranks (incumbent and v7b both 2/8 probe, 2/27 gens). The "I think…" mode is a property of the corpus-v5 objective (full-history blend + era tags), invariant to every knob tested across v5–v7: lr, rank, and their combination.
2. **Capacity alone does not move the judged frontier.** Corner B is basin-free, trains the keeper's own clean corpus, improves email AND text ppl — and still misses both bars, with email 1.62 below even the incumbent's re-run 2.14. The incumbent's email judged-likeness is not a capacity limitation.
3. **The corners don't compose.** rank16×v5 and rank32×v3 — opposite cells, different mechanisms (one trades data, one capacity) — land on identical scores (1.62 / 3.38). Every single-variable move away from the incumbent's (corpus v3, rank 16) point costs email judge; no tested cell recovers it.
4. **The val optimum is recipe-stable per corpus.** corpus v5 → val-best at iter 280 at rank 16/32 and lr 1e-5/7e-6 (losses 1.264/1.306/1.367); corpus v3 → val-best at iter 200 at rank 16/32 (1.436 incumbent, 1.431 v7b). The corpus, not the recipe, picks the optimum.
5. **Email format vs judged-likeness stay separable** (the #537 finding, third confirmation): corner B's email format moved TOWARD real (avg 228 chars vs v3's 157, real 288) while its email judge fell to 1.62.

## Corpus v3 reproducibility (corner B's data — landed in this PR)

Corner B requires the pre-v5 corpus. It was rebuilt byte-comparable with `ERA_TAG=0` (new flag, default off-preserving), `EMAIL_MIN_DATE=2021-01-01`, `MAX_TEXT_EXAMPLES=3000` (the v3-era default; v4 raised it to 6000), and the preserved pre-drain raw texts (`texts_raw.v3.jsonl`, 103,164 rows). Every recorded fingerprint reproduces EXACTLY: usable email 472 / thread-aware 156, usable bursts 16,934 / 337 chats, examples 9,705 (8,250 train / 1,455 valid), channels text 5,996 / email 1,242 / blog 21 / persona 20 / instr 2,426. All 13 leak checks PASS; primary holdout sha `14013551…` byte-identical. The rebuild is parked at `$GAVIN_VOICE_LOCAL/corpus/train-v3-rebuild-20261121.jsonl` (+ valid); the live `data/` dir was restored to corpus v5 (shas verified) after corner B's training.

## Secondary holdout (diagnostic only — era-tagged prompts, OOD for corner B and the incumbent; NOT the gate)

| candidate                              | email | text |
| -------------------------------------- | ----- | ---- |
| v3 incumbent (re-run)                  | 3.0   | 3.29 |
| corner B (rank32×v3)                   | 2.57  | 3.0  |
| corner A (rank16×v5)                   | 3.12  | 3.62 |
| v5@280 archive champion (served, 8932) | 3.14  | 4.0  |

No lane changes: the incumbent keeps the primary lane, v5@280 keeps the archive lane (corner A's secondary does not supersede it), corner B is worse than the incumbent even on OOD old-era prompts.

## Decision

**HONEST MISS ×2 — adapter_v3 remains the keeper; the 2×2 capacity×data map is complete and this lane STOPS** (per the card's stop rule: no further gavin-voice levers without a user directive). Serving is unchanged and was re-verified live with the correct request form (model field omitted) after both trainings: 8931 keeper and 8932 archive both answer in their recorded voices (3/3 voice-evident MATCH; `$GAVIN_VOICE_LOCAL/samples/serving-readback-v7.json`). Disk: superseded per-iter checkpoint stacks deleted after banking their eval evidence (14 GiB freed, 44 GiB free); every val-best/final candidate adapter is kept (1.7 GiB total), one keeper representation on disk.

Follow-ups: none filed — no promotion and no genuinely new mechanism (the basin's corpus-bound nature closes the capacity/lr lever family it was filed under). The remaining recorded-but-unproven ideas stay where they were: blog-holdout widening (diagnostic only) and any future corpus work would need a new mandate.
