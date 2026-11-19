# gavin-voice scorecard — v4 vs v3

adapter (new): `checkpoints/adapter_v4-valbest` timestamp: 2026-11-19T12:10:56

## Judge (1-5, glm-5.3, higher = more like Gavin)

| channel | base | v1 ft | v2 ft | bar  | verdict |
| ------- | ---- | ----- | ----- | ---- | ------- |
| text    | 1    | 3.88  | 3     | 3.88 | MISS    |
| email   | 1    | 2.57  | 2.88  | 2.57 | PASS    |
| blog    | 1.5  | 1     | 1.2   | none | n/a     |

## Perplexity on held-out real text (lower = closer)

| channel | base    | v1 ft  | v2 ft  | v2 vs v1 |
| ------- | ------- | ------ | ------ | -------- |
| text    | 10.8677 | 4.4408 | 4.338  | better   |
| email   | 5.2723  | 2.5521 | 2.5778 | worse    |
| blog    | 3.5     | 2.9238 | 2.8594 | better   |
| overall | 8.2171  | 3.5676 | 3.5228 | better   |

## Length/format (avg chars vs real)

| channel | real | base | v1 ft | v2 ft |
| ------- | ---- | ---- | ----- | ----- |
| text    | 51   | 185  | 41    | 25    |
| email   | 288  | 551  | 157   | 168   |
| blog    | 635  | 2049 | 1710  | 2138  |

**Acceptance bar:** NOT MET (5/7 criteria passed; bar = text judge >= 3.88, email judge >= 2.57; per-channel ppl no worse than v3).

**Generation hygiene (ft):** 27 generations — 0 start with a '+' artifact prefix, 0 degenerate '+1000…' loops. PASS (#521).
