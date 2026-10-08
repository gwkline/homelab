# Factory end-to-end fixture

A repeatable GitHub issue → Run → draft PR check, with no manual Kubernetes commands on the happy path. Protocol: [ADR-003](adr/adr-003-factory-github-ledger.md).

## Preconditions

1. `kubectl get cronjobs -n sandbox`: `factory-collector`, `factory-orchestrator`, `factory-reviewer` show `SUSPEND False`.
2. Secrets `github-token` and `factory-opencode-auth` exist in `sandbox` (don't print them).
3. The panel's factory cards load.
4. `gh auth status` works on your workstation.

## Fixture issue

Open an issue on `gwkline/homelab` titled `[factory-fixture] …` asking for one safe one-line change in `docs/` (exact file and line), so the diff stays minimal.

## Trigger

- **Preferred:** ▶ on the issue in the panel's factory card. It labels `factory/queued` and starts an orchestrator Job for that issue immediately.
- **Or:** `gh issue edit <N> -R gwkline/homelab --add-label factory/queued` and wait for the next orchestrator tick (every 10 min).

## Expected lifecycle

| Stage | Label | Observable |
| --- | --- | --- |
| claimed | `factory/in-progress` | Run comment with `<!-- factory:run:<N>:<ts> -->`, profile and workflow (`code-pr@v1`); Job `factory-issue-<N>-<ts>` in `sandbox` |
| published | `factory/draft-pr` | Run comment shows `published`, the draft PR URL, and the worker report (tests verdict, base_sha, run_id) |
| PR | — | draft PR from `factory/issue-<N>/code-pr` linking the Run comment, with `Closes #N` and the verification verdict |

```sh
gh issue view <N> -R gwkline/homelab --json labels,comments
gh pr list -R gwkline/homelab --head factory/issue-<N>/code-pr --state all
```

## Drill 1 — no duplicates

Trigger again while the run is in flight, or wait a tick. Expect exactly one Run comment per attempt; with a PR already open for the branch the tick skips and unlabels. Re-queuing a finished fixture must also skip, never open a second PR.

## Drill 2 — controlled failure

Queue an issue whose body demands an impossible change (e.g. edit a file that does not exist). The worker exits non-zero; after at most two attempts the issue lands on `factory/failed` with a redacted log tail and no PR exists. Reset with `gh issue edit <N> --remove-label factory/failed`.

Credential check: worker Jobs set `automountServiceAccountToken: false`, and only the `clone` initContainer carries `GH_TOKEN`: `kubectl get job -n sandbox <job> -o jsonpath='{.spec.template.spec.containers[0].env[*].name}'` lists no `GH_TOKEN`.

## Offline tests

```sh
npm test -w apps/factory/collector                          # eligibility, dedupe, pagination, rate limits (fake GitHub)
for t in apps/factory/*/tests/*.test.sh; do sh "$t"; done   # orchestrator, reclaimer, reviewer, sweeper, medic (gh PATH shims)
```

## Cleanup

Close the PR unmerged, delete `factory/issue-<N>/code-pr`, remove `factory/*` labels, close the issue. Jobs age out via history limits.
