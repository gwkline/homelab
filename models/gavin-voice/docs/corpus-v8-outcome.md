# gavin-voice v8 outcome — modality/formality conditioning on the all-time corpus: honest MISS, two mechanism findings

Card t_f1e6690b (2026-11-21). User mandate, verbatim: "On the voice, I actually think I prefer the old one. Maybe it would make sense to use my all time corpus of content, and train based on the output modality/formality. E.g. I speak very differently in slack than email, or on twitter than over text."

## Corpus v8 (scripts/build_corpus_v8.py, landed in this PR)

Per the card's design over the shared `build_corpus.py` machinery:

- **EMAIL — all-time (2013→2026), era-tagged where old** (< 2023-09, the v5 mechanism byte-for-byte): 1,468 usable emails, 512 thread-aware, train pool 1,246 rows / **1,064 era-tagged**. The channel output is **byte-identical to the parked corpus-v5 email channel** (`cmp` proof) — the email half of v8 is literally v5's.
- **TEXT — recent window only** (`texts_raw.v3.jsonl`, 2024-06→now, `MAX_TEXT_EXAMPLES=3000`): the standing no-basin rule applied up front from the measured v7 map — every corpus that included old-era texts trained the "I think…" basin in at every rank and lr. The card's own fallback ("otherwise drop them and note it"), not a new date-drop: the mandate's era-dropping prohibition applies to EMAIL, which keeps every row back to account start. Fingerprint = corpus v3 exactly (16,934 bursts / 337 chats / by-year 2024: 3235, 2025: 6888, 2026: 6811; 5,996 examples).
- **BLOG** — all 8 chunks, unchanged mechanism.
- **Modality conditioning** — every user turn names its channel (as ever), and the phrasing families gained instruction-style register-naming forms ("Answer this email thread: …", "Compose an email about …", "Send {name} a quick text", "Write a short post about: …"); option [0] of every family stays byte-identical to v3/v5 so the frozen holdout form remains in-distribution. ~37% of personal user turns carry a new form.
- **Instruction mix** — 25% share unchanged, but the 743 rows whose request names a writing channel (email/tweet/blog/post/letter/memo/slack — 1.8% of the alpaca pool) are excluded so a channel-naming request maps unambiguously to the personal register it names.
- Composition: **13,033 examples** (11,079 train / 1,954 valid) — text 5,996 / email 3,738 / blog 21 / persona 20 / instr 3,258. Leak checks **13/13 PASS**; primary holdout sha `14013551…` byte-identical.
- **New modalities, best-effort per the card:** X/Twitter — no X toolset or credentials exist in the agent environment (checked 2026-11-21: none across the 113 available tools, no matching env vars, no archive export on disk); the user's X archive download would unlock a follow-up run. Slack — no local export exists; a user-provided export would unlock the channel.

## Recipe (documented deviation from the card's "rank 32")

Trained at **rank 16 / lr 1e-5 / 280 iters** — the incumbent's own recipe — under the card's standing delegated authority, because the completed v7 map showed rank 32 never exceeding 3.5 judged text on any corpus while the only recorded 3.88 is rank16/lr1e-5 on this exact text data (v7b: rank32 on the same text = 3.38). The v8 result adds the counterweight measurement the v7 2×2 could not make (both corners changed rank and corpus together): **on the email channel, capacity — not lr — is the collapse variable** (see mechanisms). Val-best: **iter 280 @ 1.342**, the lowest val loss of any 7B run on record (incumbent 1.436, v7 corners 1.431/1.367); the curve descends through the schedule end (240: 1.400 → 280: 1.342), so the family's val optimum may sit beyond 280.

## Gate (frozen primary holdout, same 8-judge glm-5.3 instrument, sha verified)

| candidate | recipe | email | text | ppl email / text / overall | verdict |
| --- | --- | --- | --- | --- | --- |
| v3 incumbent (bar) | rank16/lr1e-5/240, corpus v3 | **2.57** | **3.88** | 2.5521 / 4.4408 / 3.5676 | KEEPER |
| **v8 val-best** | rank16/lr1e-5/280, corpus v8 | 1.71 | 3.12 | **2.428 / 4.4117 / 3.4972** (all better) | **MISS both** |
| v8 iter-240 (disclosed basin-free candidate, val 1.400) | same | 1.29 | 2.0 | 2.4456 / 4.4223 / 3.5112 | MISS both — val-best stands |

Hygiene: 0 `+`-artifacts, 0 degenerate loops, 0 "I think" openers in 27 primary gens. Blog ppl hair-worse (2.9336 vs 2.9238) — the only channel-worse number.

**Basin watch (during training, every checkpoint):** 0.0 / 0.125 / 0.125 / 0.25 / 0.0 / 0.0 / 0.0 (iters 40→280), controls re-probed pre-train (base 0/8, v3 incumbent 2/8 — exact calibration match). Abort signature (≥0.625 on two consecutive checkpoints) never approached.

## Mechanisms, honestly stated

1. **The basin is bound to old-era TEXT, not old-era EMAIL — the attribution question the v7 2×2 left open is now closed.** v8 trains on all-time email (1,064 era-tagged old rows) with recent-only text and is basin-free at every checkpoint, with the cleanest val-best probe of any all-time-email run (0/8). The v7b corner (basin-free) dropped both channels' old data; v8 isolates the variable.
2. **The email channel has a capacity floor: all-time era-tagged email at rank 16 collapses the email judge at both lrs.** rank16×all-time-email → email 1.62 (v7a, lr 7e-6) and 1.71 (v8, lr 1e-5); every rank32 all-time-email run scored 2.33–2.75 (v51/v52/v5/v6). Four measurements, one pattern: holding the era-separated email voices apart wants rank 32. The card's "rank 32" was right for the channel this corpus was built to upgrade.
3. **Era-conditioning transfers across channels.** v8's secondary TEXT score is **3.62 on era-tagged prompts it never saw** (v8 trains era tags on email only) vs the incumbent's 2.83 — the year-tag convention generalizes. The modality mechanism is real; the miss is in the recipe/capacity, not the mechanism.
4. **Format vs judged-likeness stay separable** (fourth confirmation): v8's email format moved toward real on avg length (210 vs v3's 157, real 288) and multiline (0.5 vs 0.1, real 0.95) while the judge fell — and the register formalized (0 exclamations/100 vs real 105, v3's ft 30; sig 0.1). The untagged recent-email voice is trained on only ~546 of ~3,700 email examples; at rank 16 the 3,192 era-tagged old rows bleed through.

## Secondary holdout (diagnostic only — era-tagged prompts; NOT the gate)

| candidate                                        | email    | text     |
| ------------------------------------------------ | -------- | -------- |
| v8 val-best                                      | 2.12     | **3.62** |
| v3 incumbent (same-day re-run)                   | 3.12     | 2.83     |
| v5@280 archive champion (served, 8932, recorded) | **3.14** | **4.0**  |

No lane changes: the incumbent keeps the primary lane; the archive adapter remains the old-voice champion the user prefers — v8's era-tagged email (2.12) does not supersede it, and its untagged email misses the primary bar outright.

## Decision

**HONEST MISS ×2 — adapter_v3 remains the keeper (8931), the archive adapter remains served (8932), no promotion.** Serving was paused for the training window per SERVING.md and restored after: both endpoints re-verified live with the correct request form (model field omitted) — 4/4 voice-evident MATCH, health 200 both (`$GAVIN_VOICE_LOCAL/samples/serving-readback-v8.json`). `data/` restored to corpus v5 (shas verified); corpus v8 parked at `$GAVIN_VOICE_LOCAL/data/train-v8-20261121.jsonl` (+ valid).

Next lever filed as the follow-up issue: the rank-32 completion cell on the v8 corpus (the direct test of mechanism 2 — expected email 2.3–2.75 by the four-point pattern, text capped by the rank-32 ceiling 3.5) and, ranked behind it, email-register rebalancing (stratified oversampling of recent-era email rows toward ~1:1 with the era-tagged pool, mechanism 4's dilution fix).
