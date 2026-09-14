# Factory collector (#78)

Polls selected GitHub repositories for eligible issues and admits them into the factory by adding `factory/queued`. GitHub issues are the primary work generator — not shell commands embedded in CronJob configuration (the demo dispatcher, `examples/dispatch-watcher.mjs` + `deploy/dispatcher/base`, is demoted in favor of this collector).

- **Ledger**: GitHub labels (ADR-002). The collector is a pure poller: it talks to the GitHub REST API and never touches Kubernetes or issue content.
- **Credentials**: a short-lived, read-scoped GitHub App installation token minted at runtime by the #70 token service (`apps/factory/github-app/token-service.ts`), with the documented transitional `GH_TOKEN` fallback (see `docs/github-app.md`).

## Declarative configuration (CronJob env, `deploy/factory/base/collector-cronjob.yaml`)

| Env | Default | Meaning |
| --- | --- | --- |
| `FACTORY_REPOS` | — (required) | Comma-separated `owner/name` allowlist |
| `FACTORY_ELIGIBILITY_LABEL` | _(empty)_ | Optional label gate. Empty = every open, non-PR issue without a factory lifecycle label is eligible (current factory behavior). Set (e.g. `run-agent`) to admit only labeled issues — collaborators-only labeling then doubles as the authorization gate |
| `FACTORY_DEFAULT_PROFILE` | `code-pr` | RunProfile recorded on collected Runs |
| `FACTORY_RULE_VERSION` | `v1` | Eligibility-rule version; part of the Run idempotency key |
| `FACTORY_SINCE` | _(empty)_ | Polling cursor (ISO-8601); see below |
| `FACTORY_QUEUED_LABEL` | `factory/queued` | Label that admits an issue into the factory |
| `FACTORY_COLLECTOR_DRY_RUN` | `false` | Log actions without any write |
| `FACTORY_MAX_PAGES` / `FACTORY_MAX_RETRIES` | `10` / `4` | Client safety caps |

## Eligibility rule

An issue is eligible when **all** of these hold:

1. it is an issue, not a pull request (`pull_request` flag absent);
2. its state is `open`;
3. if `FACTORY_ELIGIBILITY_LABEL` is set, it carries that label;
4. it carries **no** factory lifecycle label (`factory/queued`, `factory/in-progress`, `factory/pending-approval`, `factory/draft-pr`, `factory/needs-review`, `factory/approved`, `factory/failed`, `factory/cancelled`, `factory/stuck`).

## Idempotency — one repository/issue/rule version = one Run (#71)

- The queued label **is** the Run's durable ledger record: one issue + one label event = one logical Run (ADR-002 "Run identity & idempotency").
- The #71 idempotency key `sha256("github:<repo>:<issue>:<profile>@<ruleVersion>")` is computed and logged for every Run creation — deterministic across repeated polls, restarts, and future API migration.
- Rule 4 above makes re-admission impossible while any lifecycle label is present, so **repeated polls and Job TTL deletion cannot duplicate work** (the ledger is the live GitHub label set, never Kubernetes Job objects).
- The collector re-reads the single issue immediately before the label write (race narrowing), so an orchestrator that claimed the issue — or a human that closed it — in the seconds since the listing is never double-queued.
- CronJob `concurrencyPolicy: Forbid` makes the poller single-instance, the remaining (accepted, ADR-002) non-atomicity is: an orchestrator claim racing the collector's write can leave both labels; label precedence in the panel and orchestrator treats `factory/in-progress` as authoritative, so no duplicate Run results.

### Documented behaviors

| Event | Behavior |
| --- | --- |
| Label removed (`factory/queued` stripped while queued) | The issue no longer carries a lifecycle label → the next poll re-admits it (re-adds `factory/queued`). Removal before any orchestrator claim is therefore a safe "unqueue" |
| Issue closed | Skipped (`state != open`). A queued label left behind is harmless; nothing runs on closed issues |
| Issue reopened | `updated_at` bumps → the issue reappears in the poll window. If it still carries a terminal label (`factory/failed` …) it stays parked; if it is label-clean it is queued again — the same idempotency key points at the same logical Run lineage |
| Edited requirements (title/body edited) | Irrelevant to admission: the collector never reads content. The orchestrator snapshots the issue into the worker brief at claim time, so edits before the claim are picked up there |
| Retry request | Remove `factory/failed` (+ optionally add `factory/queued`). The next poll re-admits the issue; the worker branch/PR dedupe (`factory/issue-<n>/<profile>` head) updates the existing PR instead of duplicating (ADR-002) |
| Eligibility-rule change | Bump `FACTORY_RULE_VERSION`: the idempotency key changes for _new_ Runs, but the lifecycle-label gate still prevents duplicates for anything already queued or beyond |

## Polling cursor

- `FACTORY_SINCE` is a declarative ISO-8601 cursor; empty = full scan.
- The client lists `state=open&sort=updated&direction=desc` with `since` and follows pagination; a full-scan default plus label idempotency means the cursor is an **optimization, never a correctness mechanism**.
- The collector prints the next cursor (`nextSince`) in a machine-readable summary line after every tick; set it back into the CronJob env to narrow the next window. It advances only when every repo listed completely — a failed or pagination-capped tick keeps the old cursor so no work is skipped.
- Conditional requests: the client sends `If-None-Match` and honors `304 Not Modified` (tested). In the one-shot CronJob mode the in-process ETag cache only serves within a tick; `FACTORY_SINCE` is the cross-tick conditional. When the collector runs as a long-lived daemon (ADR-001 endgame), the same client skips unchanged listings entirely.

## Handling hostile inputs, rate limits, and failures

- **Untrusted task context**: issue titles/bodies/comments are never interpolated into shell, YAML, or manifests — the collector is a Node process speaking JSON REST; eligibility uses only `number`, `state`, `labels`, `updated_at`, and the `pull_request` flag. Titles appear only JSON-encoded and truncated in log lines. Bodies/comments are read later by the orchestrator, which passes them to the worker as `/task/brief.json` data.
- **Rate limits**: 429 and primary rate-limit 403s honor `Retry-After` / `x-ratelimit-reset` (capped), then retry; secondary limits are treated the same.
- **Pagination**: `Link: rel="next"` following with a page cap; an issue updated between page fetches is deduped by number (newest wins).
- **Transient failures**: network errors and 5xx retry with capped exponential backoff; client errors fail fast. Exhausted retries fail the tick visibly (non-zero exit, CronJob `backoffLimit: 0` keeps the failure record) while other repos still complete.
- **Observability**: structured per-action log lines plus a final `summary` JSON line (seen/queued/skipped/errors/nextSince) — durable in Loki, and CronJob job history retains the last 3 successful/failed pods.

## Polling, not webhooks

Polling works without public ingress: the collector only makes outbound HTTPS calls to `api.github.com` (the sandbox egress policy already allows public internet). Signed webhooks remain an optional later optimization — they would require a public receiver, which the cluster deliberately does not expose.

## Tests

```sh
sh apps/factory/collector/tests/collector.test.sh   # or: cd apps/factory/collector && npm test
```

The GitHub API is faked two ways: an in-memory fake **server** behind `fetch` (client tests: pagination, 304s, rate limits, retries, redaction) and a fake **client** (behavior tests: eligibility, duplicate-run guarantees, cursor rules, race narrowing). No network, no real tokens.
