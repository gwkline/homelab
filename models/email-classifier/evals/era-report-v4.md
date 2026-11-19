# Email action classifier — era diagnostics (v4 recipe)

_DIAGNOSTIC ONLY — the promotion gate is the fixed recent held-out split and stays untouched. Aggregate metrics only._

_Recipe: `emb-bge-base` embedder + hist head, prior window `all`; same carve ids as the v3 era report (rng 20261119)._

## Carve-out scorecard per era

(fit 24005 rows, carve 1760)

| era       |   n |   acc | respond P/R/F1    | resp support | archive F1 |
| --------- | --: | ----: | ----------------- | -----------: | ---------: |
| pre-2018  | 826 | 0.898 | 0.500/0.829/0.624 |           76 |      0.944 |
| 2018-2020 |  70 | 0.529 | 0.569/0.805/0.667 |           41 |      0.205 |
| 2021-2023 |  96 | 0.500 | 0.561/0.807/0.662 |           57 |      0.083 |
| 2024-2026 | 768 | 0.966 | 0.600/0.667/0.632 |           18 |      0.983 |

Small respond supports in old eras make those F1s noisy — read them as directional, not precise. The promotion decision never uses this table.
