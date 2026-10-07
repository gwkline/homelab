# ADR-001: Factory run contract — issue-to-PR workflow

**Status:** Superseded by [ADR-003](adr-003-factory-github-ledger.md) for storage and service boundaries (D1–D4, D8, D9). D5–D7 remain in force. **Deciders:** Gavin Kline

## Context

A software factory on the homelab: a GitHub issue becomes one durable Run, a constrained coding worker produces a tested change, and a draft PR is opened for review.

Constraints:

- Kubernetes Jobs are the only execution primitive. No Temporal/NATS/Argo/Tekton.
- A fine-grained PAT is acceptable initially; a GitHub App ([docs/github-app.md](../github-app.md)) replaces it without contract changes.
- Worker PRs are always drafts, never auto-merged. CI plus review gates promotion.

## Decisions

### D1. Service boundaries (superseded)

Originally api + collector + controller + publisher + worker over one Postgres. ADR-003 reduced this to a collector, one orchestrator CronJob that also publishes, and the per-run worker Job.

### D2–D4. Durable model, state machine, idempotency (superseded)

A seven-table Postgres schema (`repository`, `work_item`, `run`, `attempt`, `event`, `artifact`, `approval`), compare-and-swap state transitions, and a `sha256(provider:repo:issue:profile)` idempotency key. Replaced by labels, marker comments, and branch-name dedupe (ADR-003). Kept here as the v2 design if volume ever outgrows GitHub-as-ledger.

### D5. Worker input brief and output contract

Input, mounted read-only at `/task/brief.json` (schema: `apps/factory/worker/brief.schema.json`):

```json
{
  "run_id": "...",
  "repository": "gwkline/homelab",
  "issue": { "number": 85, "title": "...", "body": "..." },
  "constraints": ["draft PR only", "tests must pass"],
  "verify_command": "npm test --silent"
}
```

Output: `/out/report.json`, `/out/patch.diff`, and the log stream. Exit 0 plus a valid `report.json` is success; anything else is a failed attempt (one automatic retry).

The patch is the diff from the clone's base commit, agent commits included. Agent CLI and package-manager state (`.opencode/`, `.cursor/`, `.claude/`, `.codex/`, `.local/`, `.cache/`, `*.db`, `*.sqlite*`) is written to `.git/info/exclude` before the agent runs. A patch that still adds such a path, or exceeds `WORKER_PATCH_MAX_BYTES` (512 KiB), is rejected: report `tests: rejected`, no patch artifact, exit 65.

### D6. Credential boundaries

- Worker: no GitHub write token, no kubeconfig, netpol-restricted egress. Read-only clone; the token is unset before the agent runs.
- Publishing step: scoped token (PAT today, App installation token later), Contents + Pull requests write on allowlisted repos only.
- Orchestrator: RBAC limited to Jobs/Pods in `sandbox`.
- No token is ever logged or persisted outside its Secret.

### D7. Approval points

1. Automated: CI on the draft PR plus the reviewer CronJob. Draft → ready needs green CI and review approval.
2. Human: nothing merges autonomously by default.

### D8–D9. HTTP/MCP surface and sequence (superseded)

The panel reads and writes GitHub directly; see ADR-003 for its API.
