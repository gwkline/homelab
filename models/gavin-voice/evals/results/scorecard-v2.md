# gavin-voice scorecard — v2 vs v1

adapter (new): `checkpoints/adapter_v2`
timestamp: 2026-11-19T06:05:33

## Judge (1-5, glm-5.3, higher = more like Gavin)

| channel | base | v1 ft | v2 ft | bar | verdict |
|---|---|---|---|---|---|
| text | - | 4.5 | 3 | 4.5 | MISS |
| email | - | 1.67 | 2 | 3.5 | MISS |
| blog | - | 1.5 | 1 | 3.5 | MISS |

## Perplexity on held-out real text (lower = closer)

| channel | base | v1 ft | v2 ft | v2 vs v1 |
|---|---|---|---|---|
| text | None | 4.2775 | 4.8135 | worse |
| email | None | 2.5997 | 2.7083 | worse |
| blog | None | 2.8887 | 2.9375 | worse |
| overall | None | 3.5009 | 3.8362 | worse |

## Length/format (avg chars vs real)

| channel | real | base | v1 ft | v2 ft |
|---|---|---|---|---|
| text | 51 | None | 38 | 26 |
| email | 288 | None | 347 | 192 |
| blog | 635 | None | 1062 | 1066 |

**Acceptance bar:** NOT MET (0/7 criteria passed; bar = text judge >= 4.5 sustained, email+blog >= 3.5, per-channel ppl no worse than v1).

**Generation hygiene (ft):** 24 generations — 0 start with a '+' artifact prefix, 0 degenerate '+1000…' loops. PASS (#521).
