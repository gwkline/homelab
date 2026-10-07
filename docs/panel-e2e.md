# Panel list-and-launch e2e

`scripts/panel-e2e-smoke.sh` tests the panel against a real Kubernetes API. The panel runs as a pod under ServiceAccount `panel` in `agents`, bound to the exact grants in `deploy/panel/base/rbac.yaml` (sandbox `panel-sandbox-runs`, agents `panel-agents-viewer`), so in-cluster config, TLS trust, and RBAC are all exercised. CI runs it in the `panel-e2e` job on a kind cluster.

| Check | Expectation |
| --- | --- |
| Identity | `kubectl auth can-i` as `panel` matches production: create/list/delete Jobs and get/list/patch CronJobs in `sandbox`, get Services in `agents`; Job watch, CronJob create/delete, and secrets denied |
| Listing | `GET /api/state` returns the seeded sandbox Job and CronJob |
| Launching | `POST /api/jobs` creates a Job with the requested `LOOP_COMMAND`/`WATCHER_ISSUE` and locked-down fields (non-root uid 1000, no privilege escalation, all capabilities dropped, no SA token, RuntimeDefault seccomp) |
| Terminal state | the Job runs in a real pod, reaches `Complete`, and the panel reports `complete` |
| Input rejection | blank commands and bad issue numbers return 400 and create nothing |

RBAC is probed before the panel starts, and non-200 responses print the upstream error with a certificate/forbidden hint.

## Run

```sh
./scripts/panel-e2e-smoke.sh                     # kind cluster panel-e2e, deleted on exit
PANEL_E2E_KEEP=1 ./scripts/panel-e2e-smoke.sh    # keep fixtures, Job, and cluster
```

Needs `docker`, `kind`, `kubectl`, `node`, `curl`. The script builds the panel image and a stand-in job-runner (`apps/panel/tests/integration/runner.Dockerfile`), creates or reuses the kind cluster, and drives the panel through a port-forward. On a reused cluster it deletes only what it created.

Against another cluster (k3d, k3s), make both images pullable on the node, then reuse the current context:

```sh
docker build -f apps/panel/Dockerfile -t panel-e2e:local .
docker build -f apps/panel/tests/integration/runner.Dockerfile -t panel-e2e-runner:local apps/panel/tests/integration
# k3d: k3d image import panel-e2e:local panel-e2e-runner:local -c <cluster>
PANEL_E2E_REUSE=1 ./scripts/panel-e2e-smoke.sh
```

## Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_E2E_REUSE` | `0` | use the current kubectl context instead of kind |
| `PANEL_E2E_KEEP` | `0` | keep fixtures, created Job, and cluster |
| `PANEL_E2E_PORT` | `3933` | host port for the port-forward |
| `PANEL_E2E_TIMEOUT` | `600` | driver budget in seconds |
| `PANEL_E2E_JOB_WAIT` | `300` | created-Job terminal-state wait in seconds |
| `PANEL_E2E_PANEL_IMAGE` | `panel-e2e:local` | panel image |
| `PANEL_E2E_RUNNER_IMAGE` | `panel-e2e-runner:local` | job-runner image |

## Driver only

The assertions live in `apps/panel/tests/integration/panel-e2e.test.mjs` and work against any deployed panel, e.g. after `kubectl port-forward deploy/panel 3933:3000 -n agents`:

```sh
PANEL_E2E_URL=http://127.0.0.1:3933 \
PANEL_E2E_NS=sandbox \
PANEL_E2E_SEED_JOB=<an-existing-job> \
PANEL_E2E_CRONJOB=<an-existing-cronjob> \
PANEL_E2E_COMMAND='echo panel-e2e-launch-ok' \
  node --test apps/panel/tests/integration/panel-e2e.test.mjs
```

Without `PANEL_E2E_URL` every test skips, so `npm test` stays fast.
