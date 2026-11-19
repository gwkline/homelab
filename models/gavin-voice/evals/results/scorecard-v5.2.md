# gavin-voice scorecard — v52 vs v3

adapter (new): `checkpoints/adapter_v52-valbest` timestamp: 2026-11-19T14:46:24

## Judge (1-5, glm-5.3, higher = more like Gavin)

| channel | base | v1 ft | v2 ft | bar  | verdict |
| ------- | ---- | ----- | ----- | ---- | ------- |
| text    | 1    | 3.88  | 3.5   | 3.88 | MISS    |
| email   | 1    | 2.57  | 2.5   | 2.57 | MISS    |
| blog    | 1.5  | 1     | 1.25  | none | n/a     |

## Perplexity on held-out real text (lower = closer)

| channel | base    | v1 ft  | v2 ft  | v2 vs v1 |
| ------- | ------- | ------ | ------ | -------- |
| text    | 10.8677 | 4.4408 | 4.5053 | worse    |
| email   | 5.2723  | 2.5521 | 2.5312 | better   |
| blog    | 3.5     | 2.9238 | 2.9668 | worse    |
| overall | 8.2171  | 3.5676 | 3.5938 | worse    |

## Length/format (avg chars vs real)

| channel | real | base | v1 ft | v2 ft |
| ------- | ---- | ---- | ----- | ----- |
| text    | 51   | 185  | 41    | 70    |
| email   | 288  | 551  | 157   | 354   |
| blog    | 635  | 2049 | 1710  | 1863  |

**Acceptance bar:** NOT MET (2/7 criteria passed; bar = text judge >= 3.88, email judge >= 2.57; per-channel ppl no worse than v3).

**Generation hygiene (ft):** 27 generations — 0 start with a '+' artifact prefix, 0 degenerate '+1000…' loops. PASS (#521).
