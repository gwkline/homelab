# ADR-001: Factory Run Contract — issue-to-PR workflow

**Status:** Accepted (2026-08-26)
**Deciders:** Gavin Kline, ox-alpha
**Implements:** #71 · **Blocks:** #50/#54, #75, #76, #77, #78, #79, #73, #74, #80

## Context

We are building a software factory on the k3s homelab: a labeled GitHub issue
becomes one durable Run; a constrained coding worker produces a tested change;
a publisher opens a linked draft PR. Today nothing durable exists — loop-agent
CronJobs are ephemeral and their "ledger" is Kubernetes Job existence plus TTL.

Constraints (from #71 and operator direction):

- PostgreSQL is the durable state/queue. Plain Postgres — **no pgvector /
  pg_textsearch / extensions** for factory v1.
- Kubernetes Jobs remain the only execution primitive. No Temporal/NATS/Argo/Tekton.
- The existing PAT (personal, fine-grained) is acceptable initially; GitHub App
  (#70) replaces it later without contract changes.
- Safety: worker PRs are always **drafts**, never auto-merged. Automated review
  (CI + an agent reviewer) gates promotion to ready.

## Decisions

### D1. Service boundaries

Four small services + one image, all in `apps/factory/*`, sharing one Postgres:

| Service | Runs as | Owns | Never does |
|---|---|---|---|
| **api** (`#76`) | Deployment | All reads/writes of Run state; validation; transitions | Talks to GitHub or k8s |
| **collector** (`#78`) | Deployment (poller) | GitHub issues → create Run via API idempotently | Writes GH; touches k8s |
| **controller** (`#77`) | Deployment | Claims queued Runs → creates k8s Jobs from RunProfiles; reconciles status/logs/artifacts back via API | Talks to GitHub |
| **publisher** (`#79`) | Job (per publish) | patch → clean checkout → branch → draft PR → comment links | Reads secrets beyond its scoped token |
| **worker** (`#74`) | Job (per run) | clone → edit → verify → emit report+patch artifact | Network egress except repo + registry |

Panel (#80) becomes a thin read-only UI over the api. Hermes/MCP gets the same
read surface plus `cancel`/`retry` commands.

### D2. Durable model (smaller equivalent approved)

Seven tables, one schema owner (api service migrations):

```
repository(id, owner, name, default_profile_id)
work_item(id, repository_id, provider, external_id, title, url,
          state, labels text[], UNIQUE(provider, repository_id, external_id))
run(id, work_item_id, profile_id, requested_by, state, idempotency_key
    UNIQUE, base_ref, created_at, updated_at)
attempt(id, run_id, n, job_name, pod_ip NULL, started_at, finished_at,
        exit_code NULL)
event(id, run_id, kind, payload jsonb, at)         -- append-only audit
artifact(id, attempt_id, kind patch|report|logs, storage_path, bytes, sha256)
approval(id, run_id, kind automated-review|human, verdict, evidence_url, at)
```

- `run.idempotency_key` = `sha256(provider:repo:issue_number:profile)` —
  repeated polls/restarts/reopened issues map to the same Run (see D4).
- Artifacts live on the **panel PVC** under `/data/factory-artifacts/<run_id>/`
  (homelab-scale object storage; S3 later if needed). Logs survive pod deletion
  because controller streams them into this store before Job TTL reaps pods.

### D3. State machine

```
queued ──▶ claimed ──▶ running ──▶ publishing ──▶ published ──▶ reviewed
   │           │          │             │
   └───────────┴──────────┴─────────────┴──▶ failed / cancelled
```

Terminal states: `published`, `reviewed`, `failed`, `cancelled`.
Transitions are enforced **only by the api** (`UPDATE ... WHERE state = $expected`
— compare-and-swap). Illegal transitions are 409s, not silent overwrites.

### D4. Idempotency rules

1. Collector upserts `work_item`; creating a Run uses `INSERT ... ON CONFLICT
   (idempotency_key) DO NOTHING RETURNING id`. Zero rows = Run already exists.
2. Controller claims with `UPDATE run SET state='claimed' WHERE id=$1 AND
   state='queued' RETURNING ...` — two controllers can't double-create Jobs
   (plus advisory lock per run_id during Job creation).
3. Reopened issue ⇒ same key ⇒ collector comments on the issue pointing at the
   existing Run instead of duplicating (configurable: `reopen=supersede` later).
4. Publisher derives branch name `factory/<run_id8>/<base>` — re-runs update
   the existing PR (searched by head branch) rather than opening duplicates.

### D5. Worker input brief & output contract

Input (mounted read-only): `/task/brief.json`

```json
{ "run_id": "...", "repository": "gwkline/homelab",
  "issue": {"number": 85, "title": "...", "body": "..."},
  "constraints": ["draft PR only", "tests must pass"],
  "verify_command": "npm test --silent" }
```

Output (written by worker, uploaded by controller): `/out/report.json`,
`/out/patch.diff`, logs stream. Exit code 0 + valid `report.json` =
success; anything else = failed Attempt (retry policy: 1 automatic retry max).

### D6. Credential boundaries

- Worker: **no GitHub write token, no kubeconfig**. Read-only clone via
  short-lived URL or bundled read PAT. Untrusted execution, netpol-restricted.
- Publisher: scoped token injected per-Job (PAT today, App installation token
  after #70), least scope (Contents RW + PRs RW on target repos only).
- Controller/api: k8s RBAC limited to jobs/pods in `sandbox` namespace.
- No token is ever logged or persisted outside the Secret.

### D7. Approval points

1. **Automated review (mandatory)**: CI on the draft PR + agent reviewer
   comment. Draft→ready requires green CI + reviewer approval.
2. **Human gate (v1)**: nothing merges autonomously. `reviewed` ≠ merged.

### D8. HTTP + MCP surfaces (smallest)

API (Hono, JSON):
`POST /runs`, `GET /runs?state=&repo=`, `GET /runs/:id`,
`POST /runs/:id/cancel`, `POST /runs/:id/retry`, `GET /profiles`,
`GET /runs/:id/events`, `GET /runs/:id/artifacts/:kind`.

MCP server wraps the same endpoints for Hermes (`create_run`, `list_runs`,
`get_run`, `cancel_run`). No GraphQL, no webhooks v1 (polling every 60s).

### D9. Sequence (label → PR)

```
GitHub issue +label
  │ 60s poll
  ▼
collector ──POST /runs (idem key)──▶ api ──▶ Postgres (state=queued)
                                             ▲│
                    claim (CAS)              │▼ 60s poll
controller ◀────────────────────────────────┘
  │ create Job (RunProfile) in sandbox ns
  ▼
worker Job: clone → edit → verify → /out/{patch.diff,report.json}
  │ controller streams logs+artifacts to PVC, reconciles state
  ▼
api: running → publishing
  │
publisher Job: clean checkout → apply patch → push factory/<id> branch
  │            → open/update DRAFT PR → comment links on issue
  ▼
api: publishing → published
  │
CI runs on draft PR; agent reviewer + human review → reviewed (not merged)
```

### D10. Work decomposition (dependency order)

1. `#54` db package (Drizzle + plain SQL escape hatch) ← ADR-000 in #50
2. `#75` schema/migrations (tables above)
3. `#76` api service (Hono)
4. parallel: `#77` controller ‖ `#78` collector ‖ `#79` publisher
5. `#73` profiles (`code-pr` first) + `#74` worker image (reuses t3code layers)
6. `#80` panel runs view
7. close `#85` with a real labeled issue → draft PR on launchpad

## Consequences

- +1 Postgres (CNPG already planned), +3 small services — acceptable ops load.
- Polling (60s) instead of webhooks: fine for homelab latency targets.
- PVC-backed artifacts: fine until run volume grows; migration path to S3 is
  additive (artifact.storage_path is opaque).
- PAT risk accepted temporarily by operator; #70 swap is localized to publisher
  + collector credential wiring.
