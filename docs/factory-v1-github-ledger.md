# ADR-002: GitHub-as-ledger — no factory database in v1

**Status:** Accepted (2026-08-26, supersedes ADR-001's Postgres decision) **Implements:** #71 revision · **Simplifies:** #54 (dropped), #75 (dropped), #76 (reduced)

## Decision

GitHub issues are the **source of truth for both work AND run state** in v1. There is no factory database. Execution state lives in issue labels and a structured status comment per run. Throughput target is deliberately low (≥10 min between jobs); we accept weaker transactional guarantees in exchange for public visibility and zero infrastructure.

## The protocol

### Run identity & idempotency (no DB unique keys — discipline instead)

- One Run = one issue + one label event. Branch name is the dedupe key: `factory/<issue-number>-<label>/<base-shortsha>`.
- Before creating anything, collector/publisher search for an existing branch or PR with that head; if found, update rather than duplicate.
- Single poller instance (leader = k8s CronJob concurrency `forbid: true`) — no concurrent-poller races by construction.

### State machine → labels + marker comments

```
queued      : label "factory/queued" added by collector
claimed     : label swapped to "factory/in-progress" + status comment posted
publishing  : status comment edited (publisher Job picked up)
published   : label "factory/draft-pr" + PR link comment; queued/in-progress removed
needs-review: label "factory/needs-review" added by reviewer when PR is
              ready (isDraft:false or review requested) AND CI green;
              draft-pr stays until merge
approved    : label "factory/approved" added by reviewer when reviewDecision
              == APPROVED AND CI green — ready to merge
shipped     : PR merged → labels cleaned, linked issue closed via "Closes #N"
failed      : label "factory/failed" + failure comment (exit code, log tail)
cancelled   : label "factory/cancelled" + comment
```

Status comment format (one per Run, edited in place, never duplicated — found by `<!-- factory:run:<issue>-<ts> -->` HTML marker):

```markdown
<!-- factory:run:v1 -->

## 🏭 Factory Run

|         |                      |
| ------- | -------------------- |
| Status  | running              |
| Started | 2026-08-26T04:12:00Z |
| Worker  | code-pr@v1           |
| Attempt | 1                    |

**Log tail:** …
```

## Reviewer / approval loop (Phase 1)

The `factory-reviewer` CronJob (and the panel Review Queue) extend this ledger with a human-approval gate. PR `isDraft`, `reviewDecision`, and `statusCheckRollup` are DERIVED state — labels above remain the source of truth.

Panel API contract (tailnet-only, same trust model as `/api/factory/run`):

```
GET  /api/factory/prs?repo=<owner/name>
     → { repo, prs: [{ number, title, headRef, url, isDraft, reviewDecision,
                       state, checks: {state, conclusion}, labels, linkedIssue }] }
POST /api/factory/review { repo, pr, event: "APPROVE"|"REQUEST_CHANGES"|"COMMENT", body? }
     → POST /repos/{repo}/pulls/{pr}/reviews  (gh pr review equivalent)
POST /api/factory/merge   { repo, pr, strategy: "squash"|"merge"|"rebase" }
     → guard: pr must have factory/issue-* head AND be APPROVED with green
        checks; then PUT /repos/{repo}/pulls/{pr}/merge
GET  /api/factory/stats?repo=<owner/name>
     → { repo, weeks: [8 ISO Mondays], stats: { openIssues, openPrs,
         issuesOpened[8], issuesClosed[8], prsOpened[8], prsMerged[8] } }
GET  /api/factory/stats/rollup
     → one call over every FACTORY_REPOS repo: { totals, repos, weeks,
         history, persisted }. Cross-repo totals + per-repo breakdown derived
         from GitHub over the 8-week window; `history` is the persisted weekly
         snapshot series (JSON artifact on the panel-stats PVC, one snapshot
         per ISO week, upserted on every rollup call and by the weekly
         factory-stats-snapshot CronJob) — trend history is read from the
         artifact, so it survives beyond the GitHub-derived window.
```

Reviewer transitions (v1 read-only + comments; auto-promote behind `FACTORY_REVIEWER_AUTO_MERGE=false` default):

```
factory/draft-pr, CI pending                → nudge comment "CI ⏳"
factory/draft-pr, CI green                  → suggest ready-for-review / add needs-review
factory/needs-review                        → "@owner review?" comment
APPROVED + CI green                         → "✅ ready to merge" (+ optional auto-merge)
CI red or CHANGES_REQUESTED                 → stays, failure-style nudge
```

All state mutations are `PATCH /repos/{owner}/{repo}/issues/comments` on the marker comment. Rate limit is a non-issue at our volume (<30 calls per run).

### Artifacts

- **Patch**: pushed as a real git branch (`factory/<n>-<label>/...`) — survives forever, reviewable, no storage system needed.
- **Report**: embedded in the status comment (fenced block) + committed to the branch as `.factory/report.md`.
- **Logs**: tail (last ~100 lines) in the status comment; full logs live in the Job pod until TTL. Acceptable loss for v1.

### What stays from ADR-001

- Service boundaries shrink to **two**: collector+controller merge into one **orchestrator** (CronJob every 5 min, `forbid` concurrency), publisher stays a per-run Job.
- Worker input brief / output contract unchanged (brief.json in, patch.diff + report.json out).
- Credential boundaries unchanged: worker gets read-only, publisher scoped write token, drafts only, CI + review gate before ready.
- Panel (#80) reads GitHub directly (issues with `factory/*` labels) — no API.

### What we give up (accepted by operator)

- No atomic exactly-once under concurrent pollers → mitigated by single-instance CronJob.
- No cross-run queries/analytics → GitHub search suffices at this scale.
- Full logs die with the pod → tails preserved in comments.
- Rate limits (~5000/hr) → irrelevant at ≤1 job/10min.

## Migration path

If volume or requirements outgrow this (multi-repo fan-out, sub-minute runs, Linear inputs), ADR-001's Postgres design activates as v2 — the worker I/O contract and branch naming carry over verbatim, so only orchestrator internals change.

## Worklist (revised)

1. `#74` worker image (t3code layers, ephemeral)
2. `#73` `code-pr` profile (Job spec template, netpol-limited)
3. `#78` orchestrator (CronJob): poll labeled issues → spawn worker Jobs → manage labels/comments
4. `#79` publisher (Job): patch → branch → draft PR → links
5. `#80` panel: read-only runs view over GitHub API
6. close `#85` end-to-end on launchpad
