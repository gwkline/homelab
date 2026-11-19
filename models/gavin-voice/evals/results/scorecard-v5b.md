# gavin-voice scorecard — v5b vs v3

adapter (new): `checkpoints/adapter_v5b-valbest` timestamp: 2026-11-19T16:25:00

## Judge (1-5, glm-5.3, higher = more like Gavin)

| channel | base | v1 ft | v2 ft | bar  | verdict |
| ------- | ---- | ----- | ----- | ---- | ------- |
| text    | 1    | 3.88  | 3.43  | 3.88 | MISS    |
| email   | 1.12 | 2.57  | 1.25  | 2.57 | MISS    |
| blog    | 1.2  | 1     | 1.6   | none | n/a     |

## Perplexity on held-out real text (lower = closer)

| channel | base   | v1 ft  | v2 ft  | v2 vs v1 |
| ------- | ------ | ------ | ------ | -------- |
| text    | 12.755 | 4.4408 | 4.3474 | better   |
| email   | 5.4613 | 2.5521 | 2.667  | worse    |
| blog    | 3.6914 | 2.9238 | 3.0195 | worse    |
| overall | 9.312  | 3.5676 | 3.5711 | worse    |

## Length/format (avg chars vs real)

| channel | real | base | v1 ft | v2 ft |
| ------- | ---- | ---- | ----- | ----- |
| text    | 51   | 192  | 41    | 48    |
| email   | 288  | 559  | 157   | 194   |
| blog    | 635  | 2238 | 1710  | 1356  |

**Acceptance bar:** NOT MET (2/7 criteria passed; bar = text judge >= 3.88, email judge >= 2.57; per-channel ppl no worse than v3).

**Generation hygiene (ft):** 27 generations — 0 start with a '+' artifact prefix, 0 degenerate '+1000…' loops. PASS (#521).
