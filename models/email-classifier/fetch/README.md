# Gmail export (fetch)

The raw data comes from Gavin's mailbox through the Executor MCP sidecar (`google_gmail` integration, read-only). Nothing here talks to Google directly: no OAuth credentials exist outside the Executor connection, so this procedure always runs from a Hermes/Executor session. The script below is the exact export used for the v1 dataset.

## What gets exported (all `format: 'metadata'`, never full bodies)

| query | class |
| --- | --- |
| `in:sent after:<12mo>` then `threads.get` per thread | `respond` triggers |
| `in:archive -in:inbox -in:sent after:<24mo>` (stride sample) | `archive` |
| `in:inbox is:read` | `mark-read` |

Messages keep only `{id, threadId, internalDate, labelIds, From, Subject, snippet}` — no bodies, no attachments. The snippet is truncated to ~170 chars.

## v2 expansion sessions (2026-11-19)

- **Reply-thread audit**: `in:sent subject:Re:` all-time (2,215 sent, 566 reply threads; v1's scan had covered only 94 of them) → `threads.get` per missed thread in ~170-300-call chunks → `reply_threads_new*.jsonl`. 384 new threads (2014→2026). Sessions die well before 400 calls — budget ~200-300 per session and re-derive the unfetched tail locally between chunks.
- **Archive gap closure**: the v1 stride-10 sample left **1,800 ids unfetched** (not ~250 — `remaining.json` only tracked a 587-id slice). The newest 600 (all of the standing test window) are in `archive_gap.jsonl`, fetched with `List-Unsubscribe`/`Precedence` metadata headers; ids are newest-first so test-window rows land first. The still-unfetched older tail is parked in `data/raw/gap_remaining.json` for a later pass.
- **QuickJS trap**: this Executor build has NO `setTimeout` in the sandbox — any `sleep()` helper must guard `typeof setTimeout !== "function"` or the whole session dies on first pacing gap. Batched `Promise.all` pooling (6-way) paces fine without it.

## Hard-won Executor/Gmail gotchas (2026-11-19 session)

- **The Gmail connection dies after roughly 400-550 tool calls or ~3 minutes inside one `execute` call**, with `HTTP 403 connection_rejected "Re-authenticate"`. A fresh `execute` call after a short cooldown mints a working token again. Budget every call: keep it under ~300-400 Gmail reads and finish in well under three minutes.
- Paginating the archived list (60 pages of 500) is itself most of a session's budget. Do it **once**, dump the stride-sampled id manifest, then fetch metadata for explicit inline id chunks in later calls.
- `messages.get` with `format: 'metadata'` **does** include `snippet`, and `internalDate` is exact — no need to parse Date headers.
- `threads.get` takes `id` (not `threadId`) plus `userId`; `format: 'metadata'` + `metadataHeaders` works there too.
- `resultSizeEstimate` from `messages.list` is garbage (~501 on a 30k+ result set). Paginate to know.
- Pooling 6 concurrent gets holds ~30 req/s without tripping per-second quota; the burst limit above is the real ceiling, not rate.
- Big `console.log` output spills to a file whose path comes back in the tool result — parse it locally, never re-fetch.

## v3 full-history sweep (`mine_history.py`, 2026-11-19)

`fetch/mine_history.py` replaces the stride sampling for v3: it drains the **entire mailbox** (107k messages / 80k threads) through `threads.list` pagination + one `threads.get` per thread, driven over the Executor MCP server's HTTP JSON-RPC endpoint directly (`http://localhost:4789/mcp`, bearer from `mcp_servers.executor` in `~/.hermes/config.yaml`). A local driver is mandatory for a job this size — the Hermes-side `mcp__executor__execute` path caps calls at 300s. Every phase is checkpointed and id-deduped, so SIGTERM → re-run resumes where it stopped:

```sh
EMAIL_CLASSIFIER_HOME=~/git-dev/email-classifier-local \
  python3 fetch/mine_history.py all   # list -> get -> xmeta -> profile
```

Outputs under `$EMAIL_CLASSIFIER_HOME/mine/`: `threads_manifest.jsonl` (per-page thread ids), `threads_raw.jsonl` (per-thread compact metadata, 100-message cap with tail ids in `x`), `xmeta_raw.jsonl` (tail messages), `profile.json` (getProfile totals for coverage accounting), `driver.log`. `src/label_history.py` then derives labels from the sweep; nothing derived ever enters this repo.

Session-budget calibration for the direct-JSON-RPC path (all learned the hard way on 2026-11-19):

- **Fresh-session minting is the real quota.** A new MCP session + new Gmail token every ~5 seconds at 6-way burst concurrency trips sustained `403 Upstream rejected credentials` within a minute — self-inflicted, even with no other consumer on the mailbox. Space sessions out.
- **Burst size is the binding knob, not sustained rate.** Measured: 60-call bursts at 3-way concurrency sustain for hours (~100-150 threads/min with periodic cooldowns); bursts of 100+ trip the upstream rolling-window credential quota mid-chunk. The driver ships calibrated at 60.
- **The 403 is quota, not auth** — and it is shared mailbox-wide. A sibling Gmail drain running the same day (the gavin-voice corpus job) trips it too; the driver reacts with 90-150s cooldowns and resumes the SAME pageToken, which stays valid across cooldowns.
- **Era-interleave the fetch order.** The manifest is newest-first; a partial sweep would be era-biased at every stopping point. The driver weaves newest with oldest so the era diagnostics stay valid at any checkpoint — a sweep cut short by a runtime cap is still an honest corpus. That is exactly how the 2026-11-19 v3 corpus was cut: 28% era-balanced plus 100% of sent-bearing threads via an `in:sent` thread-id pass (respond coverage complete, archive sampled).
- **Never infer list completion from silence.** A walk that "ends" while the manifest is far below `getProfile.threadsTotal` is a silent pagination break, not a small mailbox — `mine_history.py` parks with an alarm instead of declaring done.
- **Log-line parsers are off-by-one traps.** `"THERR "` is 6 characters; slicing `line[7:]` chops the first hex digit off every failed thread id and turns retry passes into 404 hunts. The driver logs full error JSON on every failure for exactly this reason.
