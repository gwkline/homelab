# Panel list-and-launch e2e (issue #27)

`scripts/panel-e2e-smoke.sh` proves the panel's core behavior against a real
Kubernetes API — not a mock. The panel is deployed the way production deploys
it: as a pod running as the `panel` ServiceAccount (namespace `agents`), bound
to the sandbox `loop-manager` Role (`deploy/panel/base/rbac.yaml`), with the
ServiceAccount token mount supplying the cluster CA — so the server's
in-cluster `loadConfig()` path, TLS trust, and RBAC are all exercised.

What it proves, behaviorally:

1. **Identity**: the panel pod runs as ServiceAccount `panel`; `kubectl auth
   can-i` probes as that identity must match the production grants (list and
   create Jobs/CronJobs in `sandbox`; secrets denied).
2. **Listing**: `GET /api/state` returns the seeded sandbox Job and CronJob.
3. **Launching**: `POST /api/jobs` creates a sandbox Job whose live API object
   carries the requested `LOOP_COMMAND` / `WATCHER_ISSUE` env and the
   locked-down container fields (runAsNonRoot, uid 1000, no privilege
   escalation, all capabilities dropped, no SA token automount, RuntimeDefault
   seccomp).
4. **Terminal state**: the created Job runs its command in a real pod and
   reaches `Complete`; the panel then reports it as `complete`.
5. **Input rejection**: blank commands and non-numeric/overlong issue numbers
   stay rejected with 400, creating nothing.

TLS trust and RBAC breakage fail loudly: RBAC is probed before the panel
starts, and non-200 API responses print the upstream error body with a
targeted hint (certificate vs forbidden).

## Run it

```sh
# CI does this (ci.yaml job panel-e2e, disposable kind cluster):
./scripts/panel-e2e-smoke.sh

# Keep the fixtures + created Job for inspection:
PANEL_E2E_KEEP=1 ./scripts/panel-e2e-smoke.sh
```

Requirements: `docker` + `kind` + `kubectl` + `node` + `curl`. The script
builds the panel image (`apps/panel/Dockerfile`) and a tiny job-runner image
(`apps/panel/tests/integration/runner.Dockerfile` — a stand-in for the private
loop-agent image that executes `$LOOP_COMMAND` the same way), provisions a
disposable kind cluster named `panel-e2e` (reusing one that already exists),
loads the images, seeds fixtures, deploys the panel, and drives it through a
port-forward. The cluster is deleted on exit unless it existed before.

## k3d / k3s / any existing cluster

Point kubectl at the cluster, make the two images pullable on the node, and
set `PANEL_E2E_REUSE=1` (the script then skips provisioning and image
loading):

```sh
docker build -f apps/panel/Dockerfile -t panel-e2e:local .
docker build -f apps/panel/tests/integration/runner.Dockerfile -t panel-e2e-runner:local apps/panel/tests/integration
# k3d: k3d image import panel-e2e:local panel-e2e-runner:local -c <cluster>
# k3s: the node's containerd must already hold both images (or push them)
PANEL_E2E_REUSE=1 ./scripts/panel-e2e-smoke.sh
```

## Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_E2E_REUSE` | `0` | Use the current kubectl context instead of kind |
| `PANEL_E2E_KEEP` | `0` | Keep fixtures, created Job, and cluster |
| `PANEL_E2E_PORT` | `3933` | Host port for the panel port-forward |
| `PANEL_E2E_TIMEOUT` | `600` | Whole-run budget in seconds |
| `PANEL_E2E_JOB_WAIT` | `300` | Created-Job terminal-state wait in seconds |
| `PANEL_E2E_PANEL_IMAGE` | `panel-e2e:local` | Panel image ref |
| `PANEL_E2E_RUNNER_IMAGE` | `panel-e2e-runner:local` | Job-runner image ref |

## The driver alone

The HTTP/kubectl assertions live in
`apps/panel/tests/integration/panel-e2e.test.mjs` (node:test). They are
reusable against any already-deployed panel — e.g. after a `kubectl
port-forward pod/panel 3933:3000 -n agents` on the homelab cluster:

```sh
PANEL_E2E_URL=http://127.0.0.1:3933 \
PANEL_E2E_NS=sandbox \
PANEL_E2E_SEED_JOB=<an-existing-job> \
PANEL_E2E_CRONJOB=<an-existing-cronjob> \
PANEL_E2E_COMMAND='echo panel-e2e-launch-ok' \
  node --test apps/panel/tests/integration/panel-e2e.test.mjs
```

Without `PANEL_E2E_URL` every test skips, so the file is inert inside `npm
test` (which only globs `tests/*.test.ts` anyway) — the real-cluster coverage
stays in this script, kept out of the fast unit suite.
