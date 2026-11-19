<!-- Column labels are scorecard.py's legacy names: 'base' = base model, 'v1 ft' = the --baseline tag (v2wide = adapter_v2 on the widened n=8 judge), 'v2 ft' = the --tag run (v3 = adapter_v3-valbest, iter-200). -->

# gavin-voice scorecard — v3 vs v2wide

adapter (new): `checkpoints/adapter_v3-valbest`
timestamp: 2026-11-19T07:52:28

## Judge (1-5, glm-5.3, higher = more like Gavin)

| channel | base | v1 ft | v2 ft | bar | verdict |
|---|---|---|---|---|---|
| text | 1 | 3.62 | 3.88 | 2.75 | PASS |
| email | 1 | 2.29 | 2.57 | 2.5 | PASS |
| blog | 1.5 | 1.6 | 1 | none | n/a |

## Perplexity on held-out real text (lower = closer)

| channel | base | v1 ft | v2 ft | v2 vs v1 |
|---|---|---|---|---|
| text | 10.8677 | 4.4847 | 4.4408 | better |
| email | 5.2723 | 2.7083 | 2.5521 | better |
| blog | 3.5 | 2.9375 | 2.9238 | better |
| overall | 8.2171 | 3.6608 | 3.5676 | better |

## Length/format (avg chars vs real)

| channel | real | base | v1 ft | v2 ft |
|---|---|---|---|---|
| text | 51 | 185 | 23 | 41 |
| email | 288 | 551 | 192 | 157 |
| blog | 635 | 2049 | 891 | 1710 |

**Acceptance bar:** MET (7/7 criteria passed; bar = text judge >= 2.75, email judge >= 2.5; per-channel ppl no worse than v2wide).

**Generation hygiene (ft):** 27 generations — 0 start with a '+' artifact prefix, 0 degenerate '+1000…' loops. PASS (#521).
