# gavin-voice v4 — full-history corpus outcome (2026-11-19)

Mandate: "Same for the Gavin-voice model, 326 emails is sad. I should have wayyyy more responses. Keep iterating on the eval." The standing 2021-01-01 `EMAIL_MIN_DATE` rule was lifted; all sent mail back to account start and all iMessage history were mined. Drops are by REASON only, never by date.

**Outcome: eval-gated retrain MISSED — adapter_v3 stays the promoted keeper and the serving model.** The corpus work delivered (3.1x emails, best-ever email judge at the val-best checkpoint), but no candidate beat v3 on BOTH judge bars simultaneously. All three evaluated candidates are below.

## Corpus v4 (built, leak-checked, kept for the next run)

| metric | v3 | v4 |
| --- | --- | --- |
| usable emails | 472 | **1,468** (3.1x), 2013-07-05 → 2026-10-28 |
| thread-aware email prompts | 156 | **512** |
| usable text bursts | 16,934 | **34,712** (2.05x), 580 chats, 2022-05 → now |
| training examples | 9,705 | **21,036** (17,881 train / 3,155 valid) |

Drops by reason (email): auto_or_short 711, calendar_or_auto 4, dup 38 — no date drops. Drops by reason (text): garbage_row 29,162, tapback_or_empty 18,190, numeric_or_empty_burst 590. Era counts and the full stats table: `$GAVIN_VOICE_LOCAL/corpus/stats-v4.md` (local-only).

Gmail drain: complete — `labels.get SENT.messagesTotal` = 2,215 and 2,215/2,215 ids fetched (902 from v1-v3 + the 1,313-id 2013-2020 tail), id-keyed dedupe, resumable, quota-backoff (`scripts/gmail_drain_v4.py`).

## Leak checks: PASS (all 13, `scripts/leak_check.py`)

Primary holdout byte-identical (sha `14013551…`), 0 assistant/incoming/text/subject-topic twins, 0 '+'-prefixed artifacts in training data and both holdouts. The expansion surfaced **two new twin-leak classes**, both fixed in the builder before training (36 of 21,072 examples dropped):

1. Renamed-subject thread siblings — a same-thread email whose subject string differs from the held-out one, leaking thread content through its quoted incoming block.
2. Boilerplate near-twin subjects — old-era recruiting emails reusing profile phrases across subject strings.

A new era-stratified SECONDARY holdout (30 rows: 12 email < 2021 + 18 text ≤ 2023) was frozen with the same discipline — diagnostic only, never the gate.

## Gate table (frozen primary holdout, same instrument as #533, glm-5.3, n=8)

| metric | bar (beat v3) | v3 (keeper) | v4 @280 (val-best) | v4 @520 | v4.1 @200 |
| --- | --- | --- | --- | --- | --- |
| email judge | > 2.57 | 2.57 | **2.88 PASS** | 1.62 | 2.38 |
| text judge | > 3.88 | **3.88** | 3.0 | 3.12 | 3.75 |
| email ppl | ≤ 2.5521 | 2.5521 | 2.5778 | 2.5274 | **2.5134** |
| text ppl | ≤ 4.4408 | 4.4408 | 4.3380 | 4.2053 | 4.3243 |
| overall ppl | ≤ 3.5676 | 3.5676 | 3.5228 | **3.4301** | 3.4876 |
| hygiene | clean | clean | clean | clean | clean |
| **verdict** |  | **keeper** | MISS (text) | MISS (email) | MISS (both) |

Candidates: v4 = 800-iter lr 1e-5 run (val-best iter 280 @ 1.324); v4 @520 = the second val dip (1.366), evaluated as a disclosed second candidate; v4.1 = resume-from-280 at half lr (5e-6, 240 iters, val-best iter 200 @ 1.499). Selection was disclosed per candidate; no post-hoc checkpoint picking beyond these.

## Mechanisms (measured, not guessed)

1. **The email lever worked.** 3.1x emails → email judge 2.57 → 2.88 at the val-best, email format gains (avg 157→168 chars, sig rate 0→0.2, multiline 0.1→0.3 vs real 288/0.5/0.95), and the best-ever old-era email ppl (2.09-2.20 on the secondary holdout).
2. **The text regression is an era blend, not a length artifact.** Burst lengths are stable across eras (2022: 60 avg, 2023: 55, 2024-26: 51-59), but the model fits the old-era text voice better than the recent one (secondary text judge 3.5-3.75 vs primary 3.0-3.75), and the primary holdout's exemplars are recent-era. v3 trained text on 2024-06+ only.
3. **The v4@280 text failure was a mode collapse**, not data: 8/12 text generations opened with "I think…" while only 0.9% of training targets do (era-uniform). The half-lr continuation (v4.1) fixed the collapse (1/12) and recovered text to 3.75 but traded away the email gain (2.38).
4. **Third NaN mode documented**: lr 1e-5 + no grad-checkpoint NaNs at iter ~600 at the 800-iter schedule (val healthy through 560). The recipe's stability horizon is ~550 iters; future longer runs must resume at lower lr (the v4.1 pattern) or cap near 500 iters.

## Next levers (needs a decision — see the follow-up issue)

- Era handling for text: era-conditioned prompts, recency-weighted sampling (needs a mandate amendment: it is date-based), or accept the blend.
- Email format gap remains (168 vs 288 chars, sig 0.2 vs 0.5, multiline 0.3 vs 0.95).
- A two-stage curriculum (full-corpus pretrain → recent-era finish) is the natural experiment.
