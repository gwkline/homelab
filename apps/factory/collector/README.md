# Factory collector

Polls selected GitHub repositories for eligible issues and admits them into the factory by adding `factory/queued`.

- **Ledger**: GitHub labels (ADR-003). The collector talks only to the GitHub REST API; it never touches Kubernetes or reads issue content.
- **Credentials**: a short-lived, read-scoped GitHub App installation token from `apps/factory/github-app/token-service.ts`, falling back to `GH_TOKEN` (see `docs/github-app.md`).

## Configuration (CronJob env, `deploy/factory/base/collector-cronjob.yaml`)

| Env | Default | Meaning |
| --- | --- | --- |
| `FACTORY_REPOS` | — (required) | Comma-separated `owner/name` allowlist |
| `FACTORY_ELIGIBILITY_LABEL` | _(empty)_ | Optional label gate. Empty = every open, non-PR issue without a factory lifecycle label is eligible. Set (e.g. `run-agent`) to admit only labeled issues — collaborator-only labeling then doubles as the authorization gate |
| `FACTORY_DEFAULT_PROFILE` | `code-pr` | RunProfile recorded on collected Runs |
| `FACTORY_RULE_VERSION` | `v1` | Eligibility-rule version; part of the Run idempotency key |
| `FACTORY_SINCE` | _(empty)_ | Polling cursor (ISO-8601); see below |
| `FACTORY_QUEUED_LABEL` | `factory/queued` | Label that admits an issue into the factory |
| `FACTORY_COLLECTOR_DRY_RUN` | `false` | Log actions without any write |
| `FACTORY_MAX_PAGES` / `FACTORY_MAX_RETRIES` | `10` / `4` | Client safety caps |
| `GITHUB_API_BASE` | `https://api.github.com` | Override for tests / GHES |

## Eligibility rule

An issue is eligible when **all** of these hold:

1. it is an issue, not a pull request;
2. its state is `open`;
3. if `FACTORY_ELIGIBILITY_LABEL` is set, it carries that label;
4. it carries **no** factory lifecycle label (`factory/queued`, `factory/in-progress`, `factory/draft-pr`, `factory/needs-review`, `factory/failed`, `factory/cancelled`, `factory/stuck`).

## Idempotency

- The queued label **is** the Run's durable record: one issue + one label event = one logical Run (ADR-003).
- The key `sha256("github:<repo>:<issue>:<profile>@<ruleVersion>")` is computed and logged for every Run creation.
- Rule 4 makes re-admission impossible while any lifecycle label is present, so repeated polls and Job TTL deletion cannot duplicate work.
- The collector re-reads the issue immediately before the label write, so an issue claimed or closed since the listing is not re-queued.
- `concurrencyPolicy: Forbid` keeps the poller single-instance. A claim racing the label write can leave both labels; `factory/in-progress` takes precedence, so no duplicate Run results.

| Event | Behavior |
| --- | --- |
| `factory/queued` removed before a claim | The issue is label-clean again, so the next poll re-admits it |
| Issue closed | Skipped |
| Issue reopened | Terminal labels (`factory/failed` …) keep it parked; a label-clean issue is queued again |
| Title/body edited | Irrelevant to admission; the orchestrator snapshots the issue at claim time |
| Retry | Remove `factory/failed`. The next poll re-admits it and the worker updates the existing `factory/issue-<n>/<profile>` PR |
| Eligibility-rule change | Bump `FACTORY_RULE_VERSION`; the lifecycle-label gate still prevents duplicates |

## Polling cursor

- `FACTORY_SINCE` empty = full scan. The cursor is an optimization, never a correctness mechanism.
- Each tick ends with a `summary` JSON line including `nextSince`. It advances only when every repo listed completely, so a failed or pagination-capped tick never skips work.
- The client sends `If-None-Match` and honors `304`. In one-shot CronJob mode the ETag cache lives only within a tick.

## Hostile inputs and failures

- Issue titles/bodies are never interpolated into shell, YAML, or manifests. Eligibility uses only `number`, `state`, `labels`, `updated_at`, and the `pull_request` flag; titles appear only JSON-encoded and truncated in logs.
- 429 and rate-limit 403s honor `Retry-After` / `x-ratelimit-reset` (capped). Network errors and 5xx retry with capped exponential backoff; other client errors fail fast.
- A repo whose retries are exhausted fails the tick (non-zero exit) while other repos still complete.

## Tests

```sh
npm test -w apps/factory/collector
```

GitHub is faked two ways: an in-memory server behind `fetch` (client tests) and a fake client (tick behavior tests). No network, no real tokens.
