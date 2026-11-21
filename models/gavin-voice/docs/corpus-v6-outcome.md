# gavin-voice v6 outcome — basin avoidance at lr 7e-6, two-voice serving, and a serving bug found and fixed

Card t_cfd9f22e (2026-11-20), successor to the v5 honest miss (#540). Levers per the delegated decision: (1) PRIMARY — basin avoidance from scratch: fresh 7B run on corpus v5, rank 32, **lr 7e-6** (the single untried variable), ~400 iters, with an in-training basin probe at every checkpoint; (2) SECONDARY — the email-format finish recipe, preconditioned on a basin-free passing run; (4) APPROVED — two-voice serving: the era-tagged archive voice as a labeled second endpoint, keeper untouched.

## The run (single-variable fork of v5)

`configs/lora_config.v6-basin-avoid.yaml` is byte-identical to the v5 config except `learning_rate: 7.0e-6` — same corpus v5 (21,036 examples, leak checks 13/13 PASS re-run pre-train, primary holdout sha `14013551…` byte-identical), same rank 32 / scale 16, batch 2 / seq 1024, 400 iters, seed 42. GPU clean at launch (no stray processes); iter-1 val 3.080 byte-matches v5's (same seed, same data). No NaN (the ~550-iter lr-1e-5 horizon is not challenged at 400 iters and 7e-6).

Val curve (steps of 40): 1.745, 1.729, 2.045, 1.754, 2.092, 1.599, **1.306 @ 280 (best)**, 1.746, 1.577, 1.751 — the same noisy shape as v5 (1.735 … 1.264 @ 280 … 1.728), landing its val-best at **the same iter 280**, slightly higher (1.306 vs 1.264).

## Basin-probe evidence (new instrument, `scripts/basin_probe.py`)

8 fixed neutral prompts (4 text / 4 email, synthetic, committed with the script), greedy, opener-relevant max tokens. **Controls, probed pre-train**: raw base 0/8 "I think…" openers; incumbent v3-valbest 2/8 (0.25) — the incumbent itself opens with "I think" on this prompt set, so the abort signature is a sustained ratio well above control, not mere presence. Per-checkpoint ratios during the run: 0.125, 0.125, 0.0, 0.0, 0.25, 0.375, **0.375 @ the val-best**, 0.25, 0.0, 0.0. The ratio rises INTO the val-best and clears after it — the flag threshold (≥ 0.625 on two consecutive checkpoints) never fired, so the run completed.

The frozen-instrument measure at the val-best, however, matches v5 exactly: **10/27 primary generations open with "I think…"** — the same rate as v5@280.

## Gate table (frozen primary holdout, same 8-judge instrument; bars = beat v3's email 2.57 AND text 3.88)

| candidate | recipe | email | text | I-think opens | ppl vs v3 | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **v3 (incumbent)** | rank 16, corpus v3 | **2.57** | **3.88** | 0–1/27 | — | keeper |
| v6 @280 (val-best) | era-cond, rank 32, **lr 7e-6** | **2.75** | 2.62 | 10/27 | better every channel | MISS (text) |
| v6 @360 (basin-free disclosed candidate) | same run, past the valley | 2.14 | 3.0 | 3/27 | better every channel | MISS (both) |

v6@280's email 2.75 is the best judged email of any 7B candidate (v5@280 held 2.71); hygiene clean on both candidates (0 `+`-artifacts, 0 degenerate loops — the #521 bar holds); perplexity beats v3 on every channel for both candidates (v6@280: text 4.338 vs 4.441, email 2.550 vs 2.552, blog 2.871 vs 2.924).

v6@360 was evaluated because the probe read it basin-free (0/8 at 360 and 400): text recovers only to 3.0 — the same ceiling as every v5-series candidate — while email falls under the bar (2.14).

## Secondary (era-tagged old-era prompts, diagnostic only — NOT the gate)

| candidate                  | email    | text    |
| -------------------------- | -------- | ------- |
| v5 @280 (archive champion) | **3.14** | **4.0** |
| v6 @280                    | 2.75     | 3.75    |
| v6 @360                    | 3.0      | 3.38    |

No v6 candidate supersedes adapter_v5-valbest as the archive voice, so the archive endpoint serves v5's val-best.

## Email format (lever-2 recipe reference)

v6@280 ft email: avg 194 chars / multiline 0.30 / sig 0.10 (v3: 157 / 0.10 / 0; v5.2 recipe: 354 / 0.90 / 0.6; real: 288 / 0.95 / 0.5) — better than the incumbent on all three, still short of the v5.2 recipe. Lever 2 (the recent-finish format recipe) did NOT fire: its precondition is a basin-free passing run, and no basin-free point on this trajectory passes (v6@360 email 2.14 / text 3.0). The continuation/finish routes remain measured-twice trade-offs — not re-run blind.

## Mechanisms, honestly stated

1. **The basin is lr-invariant at the val optimum.** Lowering lr 1e-5 → 7e-6 from scratch, with data/rank/schedule/seed held fixed, lands the val-best at the same iter 280 with the same 10/27 "I think…" rate and a worse text judge (2.62 vs v5's 3.0). The val-best valley of corpus v5 IS the basin; the basin is not reachable-around by turning lr down within the tested range. lr as a lever on this corpus is CLOSED.
2. **Basin-free ≠ text recovery.** Past the valley (360/400: probe 0/8, eval 3/27) text recovers only to 3.0 — identical to the v5-family ceiling — and email drops below the bar. The text gap is the corpus-family gap (full-history + era-conditioning vs v3's recent-window corpus), not only the basin.
3. **The email/text frontier within the corpus-v5 family is closed.** Six candidates across three cards now trace it: (2.71, 3.0) v5@280, (2.33, 3.0) v5.1, (2.50, 3.5) v5.2, (2.75, 2.62) v6@280, (2.14, 3.0) v6@360 — no point beats both v3 bars, and the pareto edge is far from (2.57, 3.88). The next lever must change the family, not the point on the frontier (see the follow-up issue).

## Two-voice serving (lever 4, approved — delivered) + a serving bug found and fixed

The era-tagged archive voice (adapter_v5-valbest) now serves as a clearly-labeled SECOND endpoint, `make serve-archive` on 127.0.0.1:8932; the keeper on 8931 (`make serve-adapter`, adapter_v3-valbest) is untouched and remains primary. Both read back live with the correct request form (SERVING.md has the table and transcript pointer).

**Serving bug (mlx_lm 0.32.x adapter-map miss):** a chat request that passes the model id from `/v1/models` as its `model` field makes the server look the adapter up by that path, miss the `default_model` key the CLI `--adapter-path` is stored under, and answer in the RAW BASE voice — health stays 200 and hygiene stays clean, so artifact-only smokes pass vacuously. The 2026-11-19 v5-swap live-endpoint smoke hit exactly this trap (its transcript shows base-voice gens); since that swap, 8931 had been answering in the base voice when queried per SERVING.md's own (now-fixed) instructions. The correct request form — omit the `model` field — provably binds the adapters (keeper: `Oh no! I am so sorry! I will be there in 15 minutes!`, matching the offline probe and the v3 smoke verbatim). SERVING.md documents the trap, the fix, and the corrected readbacks.

## Decision

**HONEST MISS — adapter_v3 remains the promoted keeper** (email 2.57 / text 3.88, unbeaten through v6). What v6 delivered: (1) the lr lever measured CLOSED — the basin is a property of the corpus-v5 val optimum, not of lr; (2) the best judged email of any 7B candidate (2.75) with per-channel ppl domination, sitting in the same checkpoint as the text basin; (3) a committed, reusable basin-probe instrument with controls (`scripts/basin_probe.py`) whose per-checkpoint curve now exists for two runs; (4) two-voice serving, live-verified — the project's strongest validated voice is finally usable; (5) the serving adapter-map bug found, evidenced, fixed, and documented; (6) the v6 configs and chains for the next runs.

Serving/disk state: keeper = base 4-bit + adapter_v3-valbest on 8931 (the eval-scored configuration, one keeper representation, no fused duplicates on disk); archive = base 4-bit + adapter_v5-valbest on 8932. The Qwen2.5-14B-Instruct-4bit weights are GONE from the HF cache (only a `refs/main` stub remains — found at the v6 disk readback; the v5 handoff's "stays on disk" was stale). It is off the table anyway (14B measured negative at v5b, and the lever-1 recipe did not pass on 7B); a future basin-free recipe would re-download it. Next levers in the follow-up issue.
