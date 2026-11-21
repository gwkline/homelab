# gavin-voice v9/v9b outcome — #557's two levers: the rank-32 completion cell and the email-register rebalance

Card t_f02ce63b (2026-11-21), homelab issue #557 — the diagnosed continuation of the v8 miss. User mandate, verbatim: "Yeah do whatever you think will improve our scores the most on both. I want these to be fucking excellent models." + "Keep iterating on the eval." Both levers ran end-to-end on the frozen instrument with full basin-probe discipline; both are honest gate misses, and the second is the closest approach on record — with its mechanism validated. Per the card's stop rule, the v8/v9 family is now CLOSED.

## Lever 1 — the rank-32 completion cell (adapter_v9)

Corpus v8 unchanged (restored byte-exact from the parked build; leak 13/13 PASS re-run; primary holdout sha `14013551…` verified). Single training variable vs v8's recipe: rank 16 → 32 (scale 16.0, the project's rank-32 convention), plus the 400-iter schedule #557 specifies to cover a possible >280 val optimum.

**Result: val-best iter 240 @ 1.298** (lowest val on record for this corpus; the curve turned up after 240: 280 1.360 → 320 1.651 → 360 1.824 → 400 1.446 — the extension confirmed the optimum rather than missing it). Basin probes at all 10 checkpoints control-level (max 0.125; base 0/8, incumbent 2/8 re-calibrated pre-train, third consecutive exact match); val-best probe 0/8 I-think, 0 `+`, 0 loops.

| gate | v9 (rank32/240) | bar (v3 frozen) | verdict |
| --- | --- | --- | --- |
| email judge | 1.75 | 2.57 | MISS |
| text judge | 2.38 | 3.88 | MISS |
| ppl email / text / blog / overall | 2.4093 / 4.4431 / 2.9902 / 3.5069 | 2.5521 / 4.4408 / 2.9238 / 3.5676 | email+overall better, text/blog worse |
| hygiene | 0 `+`, 0 loops, 1 "I think" of 27 gens | — | PASS |

**Capacity-law readback: email landed BELOW the projected 2.3–2.75 band.** The four-point law (rank16 → 1.62/1.71; rank32 → 2.33–2.75) did not transfer to the v8 corpus family: the same email bytes that scored 2.33–2.75 at rank 32 on the v5-family corpora scored 1.75 here — the v5-family runs all carried **all-time era-tagged TEXT**, v8 carries recent-only text. **The "law" is corpus-bound, not corpus-free.** Text 2.38 also fell far under the rank-32 ceiling 3.5 (v7b scored 3.38 on the same text bytes with v3-family prompts — the v8 register-naming prompt families are the other suspect variable). Secondary: v9 2.5 / 2.43 vs incumbent same-day 2.75 / 3.25 — v8's era-transfer text advantage (3.62) did not survive the rank change.

**Lever-1-winning rank: 16** (v8@r16 text 3.12 vs v9@r32 2.38, decisive outside the ±0.5 judge noise band; email a tie at 1.71 vs 1.75).

## Lever 2 — the email-register rebalance (adapter_v9b), the gate shot

Corpus v9b (`scripts/build_corpus_v9.py`, this PR): corpus v8 rebuilt **byte-identical** (filecmp proof vs the parked train-v8/valid-v8), then the untagged recent-era email register oversampled **after the split, train-side only**: +2,226 rows (182 pool rows × 4.08 cycles, fresh phrasing draws from the v8 family with `era=None`, dedicated RNG seed 97) → era-tagged email in train **2,696 vs untagged-after 2,696 — ratio exactly 1.0**. Valid is byte-identical to v8's, so the val instrument is unchanged. Oversampling, not date-dropping: all 1,064 old-era rows stay in. Every added row verified (0 era-tagged carriers, 0 `+`-prefix). Instruction rows stay 3,258 (share 0.214 of the enlarged total). Leak checks 13/13 PASS on the installed build.

Trained at the lever-1-winning rank (16 / lr 1e-5 / 400 iters). **Result: val-best iter 240 @ 1.530**; basin probes control-level at all 10 checkpoints (max 0.25 = the incumbent control's exact level); val-best probe 0/8 basin-free.

| gate | v9b (rank16-rebalanced/240) | bar (v3 frozen) | verdict |
| --- | --- | --- | --- |
| email judge | 2.33 | 2.57 | **MISS by 0.24** (inside the ±0.5 n=8 judge noise band) |
| text judge | **4.14** | 3.88 | **PASS — the first primary text score above the bar in project history** |
| ppl email / text / blog / overall | 2.3996 / 4.5217 / 2.9121 / 3.5428 | 2.5521 / 4.4408 / 2.9238 / 3.5676 | email/blog/overall better; **text WORSE by 0.08** |
| hygiene | 0 `+`, 0 loops, 1 "I think" of 27 gens | — | PASS |

**GATE_OVERALL: MISS** — the strict AND-gate failed on email judge (0.24) and text ppl (0.08). No promotion; bars stay frozen; no re-run shopping.

**The lever's own question — did the untagged email register recover? — YES, on every axis:**

| measure           | v8   | v9b                                      | real |
| ----------------- | ---- | ---------------------------------------- | ---- |
| email judge       | 1.71 | **2.33** (+0.62, outside the noise band) | —    |
| exclamations /100 | 0    | **40**                                   | 105  |
| sig rate          | 0.1  | **0.5**                                  | 0.5  |
| multiline rate    | 0.5  | **0.8**                                  | 0.95 |
| avg chars         | 210  | **262**                                  | 288  |

And the text channel did not pay for it: **text 4.14**, +1.02 over v8 (outside the band), above the 3.88 bar itself — while text ppl went hair-worse (4.52 vs 4.44, +0.08): another measured instance of judged-likeness and perplexity separating.

Judge trail on this corpus design: v8 r16 1.71/3.12 → v9 r32 1.75/2.38 → **v9b r16-rebalanced 2.33/4.14**.

Secondary (era-tagged prompts, diagnostic): v9b **2.43 / 4.12** vs incumbent same-day 2.75 / 3.25 — v9b's era-tagged text (4.12) nearly matches the archive adapter's recorded 4.0 while its email misses the archive's 3.14.

## Instrument integrity (both levers, same day)

Incumbent same-day primary re-run: **ppl byte-identical** to the frozen v3 numbers on all four channels (twice), judge text exact (3.88) twice, email +0.14 (inside the ±0.5 band). The frozen bars were never re-baselined.

## Decision

**HONEST MISS ×2 — adapter_v3 remains the keeper (8931), the archive adapter remains served (8932), no promotion, no symlink flip.** Serving was paused per SERVING.md for both training windows and restored after: 4/4 voice-evident readbacks MATCH with the correct request form (model field omitted) — `$GAVIN_VOICE_LOCAL/samples/serving-readback-v9.json`. `data/` restored to corpus v5 (shas verified); corpus v9b parked at `data/train-v9b-20261121.jsonl` (+ valid, byte-identical to v8's; pre-oversample rebuild proof at `data/train-v9-rebuild-check.jsonl`); superseded checkpoint stacks deleted after banking evidence (val-best adapters preserved at `checkpoints/adapter_v9-valbest/`, `checkpoints/adapter_v9b-valbest/`).

**Stop rule: the v8/v9 family is CLOSED.** Ten evaluated candidates against the v3 keeper (v5, v5.1, v5.2, v5b-14B, v6, v7a, v7b, v8, v9, v9b) never passed both bars; the measured frontier ends here, on evidence. v9b is the closest approach ever recorded — text above its bar for the first time, email within the judge's own noise band of its bar — but a miss is a miss, and the record says so plainly. Next steps exist and are NOT fired (all need the user's explicit go, per the stop rule): (a) the register factor beyond 1:1 (2–3×) as a single-variable email push — the 1.71→2.33 jump at exactly 1:1 suggests headroom, and email is the only judged bar still short; (b) an instrument de-noising pass (larger judge n with re-calibrated bars) if the ±0.5 band is to be narrowed — a re-baselizing decision, the user's call; (c) the two-register serving disposition (request-convention documentation so the old voice is usable by design) — in flight on the follow-up card that auto-resumed when this one completed. X/Twitter and Slack channels remain blocked on user-provided exports (unchanged, per #557).

## Provenance note

Corpus v9b's builder was authored on the parallel auto-spawned card t_c79040ab (which detected this card's live training, yielded the training lane, and dependency-blocked itself on this card's completion). Its train-side-only build was adopted over the pool-rebuild variant considered here because corpus v8's train rows stay byte-identical and the valid split — the val-loss instrument — is unchanged. The builder is committed as `scripts/build_corpus_v9.py` with the adoption recorded in its docstring.
