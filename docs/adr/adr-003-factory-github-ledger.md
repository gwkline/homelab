# ADR-003: GitHub as the factory ledger — no factory database

**Status:** Accepted. Supersedes the Postgres ledger of [ADR-001](adr-001-factory-run-contract.md) (D2–D4, D8, D9); ADR-001's worker I/O contract, credential boundaries, and approval points still apply. **Deciders:** Gavin Kline

## Decision

GitHub issues are the source of truth for both work and run state. There is no factory database: execution state lives in issue labels plus one marker comment per Run. Throughput is deliberately low (one worker at a time per repo), so we trade transactional guarantees for public visibility and zero infrastructure.

## Components (all CronJobs in `sandbox`, `concurrencyPolicy: Forbid`)

| CronJob | Schedule | Role |
| --- | --- | --- |
| `factory-collector` | `:05` hourly | Admits eligible open issues by adding `factory/queued` (`apps/factory/collector/README.md`) |
| `factory-orchestrator` (+ `-launchpad`) | every 10 min | Claims one queued issue, spawns a worker Job from the profile, then publishes: apply patch → push branch → draft PR |
| `factory-reviewer` (+ `-launchpad`) | twice hourly | Nudges/labels PRs by CI and review state; squash-merges green factory PRs (`FACTORY_REVIEWER_AUTO_MERGE=true`) |
| `factory-medic` | `:41` hourly | Repairs freshly CI-red factory PRs |
| `factory-sweeper` | `:48` hourly | Keeps PRs from stranding (pings, fix issues, drift warnings) |
| `factory-reclaimer` | `:25` hourly | Requeues `factory/failed` issues after a cooldown; parks them on `factory/stuck` when attempts run out |
| `factory-security` | every 6 h | Repo security sweep (`profile-security`) |

Single-instance CronJobs are the concurrency control: no two pollers race by construction.

The shell components share `apps/factory/lib/factory.sh`, so each of these has one definition:

- the `gh` wrapper, with a timeout on every call and a retried auth probe;
- check classification;
- the per-repo verify command;
- label and marker names.

The label list itself is `apps/factory/lib/labels.json`, which the collector also reads.

Each worker Job is rendered from its RunProfile ConfigMap (`deploy/factory/base/profile-*.yaml`) by `apps/factory/orchestrator/worker-job.jq`. The profile sets:

- image and ServiceAccount;
- resources, including `ephemeral-storage`;
- the `/work` emptyDir `sizeLimit`;
- `activeDeadlineSeconds`, `backoffLimit` and `ttlSecondsAfterFinished`.

Worker pods run at the `restricted` Pod Security level.

## Run identity and idempotency

- One Run = one issue + one profile. The branch `factory/issue-<N>/<profile>` is the dedupe key: before creating anything the orchestrator looks for an existing branch/PR with that head and updates or skips instead of duplicating.
- Run marker comment `<!-- factory:run:<issue>:<ts> -->`, edited in place, carries status, profile/workflow (`code-pr@v1`), attempt, the worker report on success, and a redacted log tail on failure.
- A worker failure retries once (two run markers max), then the issue lands on `factory/failed`.

## State machine (labels)

| Label | Set by | Meaning |
| --- | --- | --- |
| `factory/queued` | collector, panel ▶, human | waiting for the orchestrator |
| `factory/in-progress` | orchestrator | claimed; run marker posted |
| `factory/draft-pr` | orchestrator | draft PR open; stays until merge |
| `factory/needs-review` | reviewer | PR ready and CI green |
| `factory/failed` | orchestrator | worker failed; reclaimer may requeue |
| `factory/stuck` | medic, reclaimer | retries exhausted; needs a human |
| `factory/cancelled` | panel cancel, human | stopped |

PR `isDraft`, `reviewDecision`, and check rollup are derived state; labels remain the ledger. A merged PR closes its issue via `Closes #N`. Factory PRs merge without a human once CI is green; the trust boundary is admission (the collector's `factory` label, which only collaborators can apply).

## Medic

Per freshly red PR (one repair per tick, at most one in flight) the medic posts a repair brief (failing checks, truncated logs, diff, verify command) and requeues the linked issue. Retry state lives in markers on the PR:

| Marker | Meaning |
| --- | --- |
| `<!-- factory:medic:<head-sha>:queued -->` | repair dispatched for that head |
| `<!-- factory:medic:<head-sha>:failed -->` | that head went red again after a repair |

Budget: `FACTORY_MEDIC_MAX_ATTEMPTS` (3) failures per head SHA; a new push resets it. Exhausted → issue relabeled `factory/stuck` + give-up comment. The medic's only write path is a fast-forward push to the PR's existing `factory/issue-<N>/<profile>` branch (no force, no new branches, never `main`).

## Sweeper

Never closes or merges. Per open, non-draft factory PR:

| Condition | Action |
| --- | --- |
| green, awaiting review ≥ `SWEEP_PING_AFTER_H` (168) | one review-request ping to `SWEEP_PING_REVIEWER` |
| red < `SWEEP_RED_GRACE_H` (24) ago, or medic retries left | leave for the medic |
| red, stale, and medic exhausted (≥ `SWEEP_MEDIC_MAX_RETRIES` `factory:medic:retry:<i>` markers, none at all, or issue on `factory/stuck`) | file one `factory/queued` fix issue (`<!-- factory:sweep:filed:<pr> -->`) |
| `main` > `SWEEP_DRIFT_COMMITS` (50) ahead of base | rebase warning (`<!-- factory:sweep:drift:<pr> -->`, edited in place) |

Re-arm a sweep by deleting the `factory:sweep:filed` comment. Dry run: `FACTORY_SWEEP_DRY_RUN`.

## Panel API (tailnet-only)

Every mutation needs a caller: an allowlisted Tailscale login arriving through the panel's own Tailscale proxy from the panel page itself, or a bearer token (one per Executor connection). Both come from Secret `panel-auth`, which maps each to a name; that name is the Run's "requested by". Cross-site requests are refused (`apps/panel/server/auth.ts`).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/factory/all-issues`, `/runs?repo=`, `/run?repo=&issue=`, `/profiles` | read views over GitHub; `/run` adds the run's Jobs |
| `POST /api/factory/run`, `/run/cancel`, `/run/retry` | queue, cancel, or retry a Run |
| `GET /api/factory/prs?repo=` | factory PRs with draft/review/check state |
| `POST /api/factory/review` | approve / request changes / comment; requires a `factory/issue-*` head |
| `POST /api/factory/ready` | mark a draft factory PR ready for review (GraphQL `markPullRequestReadyForReview`) |
| `POST /api/factory/merge` | merge; requires a `factory/issue-*` head, APPROVED, green checks |
| `GET /api/factory/stats?repo=`, `/stats/rollup` | 8-week issue/PR stats (cached ~120 s); rollup persists weekly snapshots on the panel-stats PVC, also written by the `factory-stats-snapshot` CronJob |

## Artifacts

- **Patch:** a real git branch — reviewable, durable, no storage system.
- **Report:** in the run marker comment and committed as `.factory/report.md`.
- **Logs:** tail in the run comment; full logs in Loki for 30 days, queryable by `job_name` ([deploy/loki/README.md](../../deploy/loki/README.md)).

## Trade-offs accepted

- No exactly-once under concurrent pollers → single-instance CronJobs.
- No cross-run analytics → GitHub search and the panel stats rollup suffice.
- GitHub rate limits (5000/h) are irrelevant at this volume (< 30 calls per Run).

If volume outgrows this (sub-minute runs, many repos fanning out), ADR-001's Postgres design is the v2 path; the worker I/O contract and branch naming carry over, so only orchestrator internals change.
