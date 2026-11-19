# Gmail export (fetch)

The raw data comes from Gavin's mailbox through the Executor MCP sidecar (`google_gmail` integration, read-only). Nothing here talks to Google directly: no OAuth credentials exist outside the Executor connection, so this procedure always runs from a Hermes/Executor session. The script below is the exact export used for the v1 dataset.

## What gets exported (all `format: 'metadata'`, never full bodies)

| query | class |
| --- | --- |
| `in:sent after:<12mo>` then `threads.get` per thread | `respond` triggers |
| `in:archive -in:inbox -in:sent after:<24mo>` (stride sample) | `archive` |
| `in:inbox is:read` | `mark-read` |

Messages keep only `{id, threadId, internalDate, labelIds, From, Subject, snippet}` — no bodies, no attachments. The snippet is truncated to ~170 chars.

## Hard-won Executor/Gmail gotchas (2026-11-19 session)

- **The Gmail connection dies after roughly 400-550 tool calls or ~3 minutes inside one `execute` call**, with `HTTP 403 connection_rejected "Re-authenticate"`. A fresh `execute` call after a short cooldown mints a working token again. Budget every call: keep it under ~300-400 Gmail reads and finish in well under three minutes.
- Paginating the archived list (60 pages of 500) is itself most of a session's budget. Do it **once**, dump the stride-sampled id manifest, then fetch metadata for explicit inline id chunks in later calls.
- `messages.get` with `format: 'metadata'` **does** include `snippet`, and `internalDate` is exact — no need to parse Date headers.
- `threads.get` takes `id` (not `threadId`) plus `userId`; `format: 'metadata'` + `metadataHeaders` works there too.
- `resultSizeEstimate` from `messages.list` is garbage (~501 on a 30k+ result set). Paginate to know.
- Pooling 6 concurrent gets holds ~30 req/s without tripping per-second quota; the burst limit above is the real ceiling, not rate.
- Big `console.log` output spills to a file whose path comes back in the tool result — parse it locally, never re-fetch.
