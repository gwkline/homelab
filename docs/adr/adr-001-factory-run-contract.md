# ADR-001: Factory run contract — issue-to-PR workflow

**Status:** Superseded by [ADR-003](adr-003-factory-github-ledger.md) for storage and service boundaries (D1–D4, D8, D9). D5–D7 remain in force. **Deciders:** Gavin Kline

## Context

A software factory on the homelab: a GitHub issue becomes one durable Run, a constrained coding worker produces a tested change, and a draft PR is opened for review.

Constraints:

- Kubernetes Jobs are the only execution primitive. No Temporal/NATS/Argo/Tekton.
- A fine-grained PAT is acceptable initially; a GitHub App ([docs/github-app.md](../github-app.md)) replaces it without contract changes.
- Worker PRs open as drafts. Green CI gates promotion and merge (D7).

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

Output: `/out/report.json`, `/out/patch.diff`, and the log stream.

- Exit 0 plus a valid `report.json` is success.
- Exit 78, from the clone step or the worker, means the run **cannot be attempted**: a required input is missing (the private skills, the model key, a valid brief) or the setup is wrong. The worker logs `CANNOT ATTEMPT: <reason>` and reports `tests: cannot-attempt`. The orchestrator parks the issue on `factory/stuck` with that reason and does not retry.
- Anything else is a failed attempt (one automatic retry).

The patch is the diff from the clone's base commit, agent commits included. Agent CLI and package-manager state (`.opencode/`, `.cursor/`, `.claude/`, `.codex/`, `.local/`, `.cache/`, `*.db`, `*.sqlite*`) is written to `.git/info/exclude` before the agent runs. A patch that still adds such a path, or exceeds `WORKER_PATCH_MAX_BYTES` (512 KiB), is rejected: report `tests: rejected`, no patch artifact, exit 65.

### D6. Credential boundaries

- Worker: the agent container holds no GitHub credential and no kubeconfig, and its egress is netpol-restricted. Unsetting a token in the entrypoint is not enough: the entrypoint is PID 1, so its initial environment stays readable in `/proc/1/environ` by the agent (same uid).
  - The Job's `clone` initContainer (`apps/factory/worker/prepare.sh`) is the only container given the `github-token` Secret. It clones into a shared `emptyDir` through a throwaway `GIT_ASKPASS` helper, so no URL or file keeps the token, syncs the pinned private skills, and exits.
  - The agent container refuses to start if it finds a credential beside a pre-cloned repo.
  - The model key reaches it as a mounted file (`OPENCODE_AUTH_FILE`), not env.
  - The clone token is still the owner's PAT; a read-only, single-repo App installation token ([docs/github-app.md](../github-app.md)) is the follow-up.
- Publishing step: scoped token (PAT today, App installation token later), Contents + Pull requests write on allowlisted repos only.
- Orchestrator: RBAC limited to Jobs/Pods in `sandbox`.
- No token is ever logged or persisted outside its Secret.

### D7. Approval points

1. Admission (human): only issues a collaborator labels `factory` become Runs (the collector). That label is the one human decision before a merge.
2. Merge (automated): the reviewer CronJob flips a green draft to ready and squash-merges it once `ci` is green. There is no approval step between the worker's patch and the draft PR.
3. A factory PR never changes what admits or merges it. `factory_protected_paths` (`apps/factory/lib/factory.sh`) covers `.github/**`, the reviewer, the collector, the factory library and `renovate.json`. `pull_request` CI runs the workflow from the PR head, so without this an edited workflow could turn `ci` green.
   - The orchestrator refuses to publish a patch touching those paths and parks the issue on `factory/stuck`.
   - The reviewer re-checks the PR's files before every merge, failing closed.
   - The collector also admits only issues authored by an `OWNER`, `MEMBER` or `COLLABORATOR`, since the body becomes the agent's task.

### D8–D9. HTTP/MCP surface and sequence (superseded)

The panel reads and writes GitHub directly; see ADR-003 for its API.
