# gavin-voice scorecard — v2.1 clean-holdout re-baseline (issue #528)

The frozen holdout was v1-era: its text exemplars carried the streamtyped `+`-length-byte leak (28 lines over 25/60 rows) plus reaction junk, so every judge/ppl/format number since v1 graded clean generations against dirty exemplars. v2.1 cleaned it IN PLACE (`scripts/clean_holdout.py`, rules imported from `build_corpus.py`: per-line strip `^\+.` before tapback-check, tapback/junk rows dropped, incoming context stripped): 86→81 rows, ZERO `+`-prefixed exemplars or incoming context verified programmatically, sha256 `14013551…` (proof: `holdout-clean-proof.json`). The clean also exposed 2 holdout-twin rows inside v2's training data (the dirty reals had never matched the clean corpus, so the exclusion missed them) — corpus v2.2 excludes them; v1's near-twin exposure is disclosed below.

These are the first TRUE v1-vs-v2 reads on that instrument (judge glm-5.3, same eval.py, 3 clean exemplars/channel).

## Re-baseline: adapter_v1 vs adapter_v2 (clean holdout)

| channel | judge base | judge v1 | judge v2 | ppl base | ppl v1 | ppl v2 |
| ------- | ---------- | -------- | -------- | -------- | ------ | ------ |
| text    | 1          | **3.5**  | 2.75     | 10.8677  | 4.4504 | 4.4847 |
| email   | 1          | 1.25     | **2**    | 5.2723   | 2.5993 | 2.7083 |
| blog    | 1.5        | 1.5      | 1        | 3.5      | 2.8906 | 2.9375 |
| overall | -          | -        | -        | 8.2171   | 3.593  | 3.6608 |

Generation hygiene on the clean holdout: **v1: 18/24 '+'-prefixed** (0 degenerate loops) — v2: **0/24**, 0 loops.

Honest reads, against the v2-era expectations:

- v1's old text 4.5 was ~1pt of artifact-matching: **3.5 clean**. But the predicted "v2 wins cleanly once exemplars stop punishing it" did NOT hold — v2's text judge also slipped (3 → 2.75), and **v1 still beats v2 on text judge and on every ppl channel**. v1 also nails text length (avg 52 chars vs real 51); v2 under-generates (23 chars).
- v1 is disqualified as a keeper regardless: **18/24 of its generations are '+'-prefixed** on the clean holdout — unusable output. (v1's ppl edge also carries soft exposure to its dirty near-twin training rows.)
- v2 wins email (2 vs 1.25) with perfect hygiene — **adapter_v2 stays the keeper.**

## Capacity run: adapter_v21 (seq 1024, batch 2, iter-240 val-best 1.371)

The seq-1024 run on corpus v2.2 (240 iters, lr 1e-5 NaN-safe; batch 4 × seq 1024 OOM-thrashes 36 GB, see the config header). Gate: promote only if email judge ≥ 3.5, no text regression, hygiene clean.

| gate | v2 (incumbent) | v2.1 capacity | verdict |
| --- | --- | --- | --- |
| email judge ≥ 3.5 | 2 | **1.5** | MISS |
| text judge (no regression) | 2.75 | **3.33** | PASS |
| text ppl (context) | 4.4847 | 4.3245 | better (v2 had 1 memorized row of 24) |
| hygiene | 0/24 '+', 0 loops | 0/24 '+', 0 loops | PASS |
| email avg chars (real 288) | 192 | **266** | format gap closed |
| email multiline (real 0.95) | 0 | **0.4** | format gap closed |
| email sig rate (real 0.5) | 0 | **0.1** | improved, partial |

**Verdict: NOT promoted — keeper stays adapter_v2.** seq 1024 fixed the truncation-driven email format gaps exactly as hypothesized (multiline 0→0.4, avg 192→266 chars, sig 0→0.1) and improved text, but the email judge fell to 1.5 (< v2's 2): with subject-only prompts the thread is unknowable, and the longer, better-formatted replies hallucinate specifics (fabricated roles and credentials; one degenerate number repeat). The miss is content grounding, not capacity. Next levers: thread-content-aware email prompts in the corpus, persona grounding, email data beyond 471, judge n 4→8.
