# Factory E2E fixture procedure (#85)

Written fixture for reproducing the full GitHub issue → factory Run → draft PR
flow. Another agent (or engineer) should be able to follow this top-to-bottom
with no improvisation and no manual Kubernetes commands on the happy path.

Architecture: ADR-002 (`docs/factory-v1-github-ledger.md`) — GitHub is the
ledger, labels are the state machine, one marker comment per Run.

## Preconditions (check once)

1. Cluster reachable; factory CronJobs unsuspended in `sandbox`:
   `kubectl get cronjobs -n sandbox` → `factory-collector`,
   `factory-orchestrator`, `factory-reviewer` show `SUSPEND` = `False`.
2. Secrets exist in `sandbox`: `github-token` (fine-grained PAT) and
   `factory-opencode-auth` (opencode auth.json, base64). Do not print them.
3. Panel reachable (factory cards show issues + review queue).
4. `gh auth status` works on your workstation.

## Fixture issue (safe test work)

Pick a **safe change** that cannot break anything: a one-line typo fix or doc
clarification in `docs/`. Open it on `gwkline/homelab`:

- Title must start with `[factory-fixture]` so it is identifiable and
  deletable later.
- Body: exactly what to change (one file, one line) so the worker stays
  minimal and diff-scoped verification applies.

## Trigger the Run (no kubectl)

Option A (preferred): press ▶ on the fixture issue in the panel's factory
card — it labels the issue `factory/queued` and creates an immediate
orchestrator Job pinned to that issue (avoids the label-propagation race).

Option B: label it yourself and let the cron pick it up:

```sh
gh issue edit <N> -R gwkline/homelab --add-label factory/queued
```

The collector keeps unlabeled open issues queued hourly; the orchestrator tick
(`*/10`) claims the oldest queued issue.

## Expected lifecycle (assert each step)

| Stage      | Issue label        | Observable                                                              |
| ---------- | ------------------ | ----------------------------------------------------------------------- |
| claimed    | `factory/in-progress` | New **Factory Run** comment with `<!-- factory:run:<issue>:<ts> -->` marker, Profile + Workflow (`code-pr@v1`) rows; a `factory-issue-<N>-<ts>` Job in `sandbox` |
| published  | `factory/draft-pr` | Run comment edited to `published` with draft PR URL + `<details>` **worker report** (tests verdict, base_sha, run_id) |
| PR         | —                  | Draft PR from `factory/issue-<N>/code-pr`, body links the Factory Run comment, `Closes #N`, verification verdict |

Watch with:

```sh
gh issue view <N> -R gwkline/homelab --json labels,comments
gh pr list -R gwkline/homelab --head factory/issue-<N>/code-pr --state all
```

Logs/reports: the Run comment carries the redacted log tail on failure and the
structured worker report on success. Full pod logs stay with the Job pod until
TTL (accepted loss for v1).

## Drill 1 — repeated poll/restart (no duplicates)

While the run is in flight, trigger again (Option A) or wait for the next
cron tick. Expected: **exactly one** Run marker comment is created per
attempt — the in-progress label keeps the second tick away; if a PR already
exists for `factory/issue-<N>/<profile>`, the tick skips and unlabels instead
of creating a duplicate Run or PR. Re-running a *finished* fixture (label
`factory/queued` again with a PR present) must end in the same skip, never a
second PR.

## Drill 2 — controlled worker failure (failed Run, no PR)

```sh
kubectl create job --from=cronjob/factory-orchestrator factory-fixture-fail -n sandbox
```

after first labeling the fixture `factory/queued` and temporarily breaking the
worker deterministically: re-trigger the panel run with an issue whose body
demands an impossible change (e.g. "edit a file that does not exist"). The
worker exits non-zero → after ≤2 attempts the issue lands on
`factory/failed` with a **redacted log tail** in the Run comment, and no PR
must exist for the branch. Reset with `gh issue edit <N> --remove-label factory/failed`.

Credential check while a worker pod runs: `kubectl exec` is not available on
completed pods, but the Job spec shows `automountServiceAccountToken: false`
and the token only rides env `GH_TOKEN` — the worker entrypoint unsets it
after the authenticated clone, so the agent process never holds it.

## Offline fixture tests (no cluster)

```sh
bash apps/factory/collector/tests/collector.test.sh    # PASS: collector queues only eligible issues
bash apps/factory/reviewer/tests/review.test.sh        # PASS: reviewer label filtering behaves
bash apps/factory/orchestrator/tests/runtime-path.test.sh  # PASS: orchestrator Git runtime path is covered
```

These run `run-collector.sh` / `run-reviewer.sh` against `gh` PATH shims with
`GH_FIXTURE_DIR` JSON fixtures — the same technique to extend coverage.

## Cleanup

Close the PR (do not merge), delete the branch
`factory/issue-<N>/code-pr`, remove `factory/*` labels from the fixture
issue, close the issue. Jobs in `sandbox` age out via history limits.
