# Email action classifier — era diagnostics (v3 history)

_DIAGNOSTIC ONLY — the promotion gate is the fixed recent held-out split and stays untouched. Aggregate metrics only._

## Label drift across eras (train rows)

| era       |  rows | respond | archive | mark-read | respond share |
| --------- | ----: | ------: | ------: | --------: | ------------: |
| pre-2018  |  9374 |     384 |    8990 |         0 |         0.041 |
| 2018-2020 |   356 |     209 |     147 |         0 |         0.587 |
| 2021-2023 |   481 |     285 |     196 |         0 |         0.593 |
| 2024-2026 | 15554 |      93 |   15445 |        16 |         0.006 |

## Carve-out scorecard per era

(fit 24005 rows, carve 1760; same recipe)

| era       |   n |   acc | respond P/R/F1    | resp support | archive F1 |
| --------- | --: | ----: | ----------------- | -----------: | ---------: |
| pre-2018  | 826 | 0.908 | 0.504/0.855/0.634 |           76 |      0.948 |
| 2018-2020 |  70 | 0.500 | 0.561/0.780/0.653 |           41 |      0.150 |
| 2021-2023 |  96 | 0.552 | 0.580/0.895/0.703 |           57 |      0.089 |
| 2024-2026 | 768 | 0.969 | 0.667/0.778/0.718 |           18 |      0.984 |

Small respond supports in old eras make those F1s noisy — read them as directional, not precise. The promotion decision never uses this table.
