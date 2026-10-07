# Panel e2e

`scripts/panel-e2e-smoke.sh` tests the panel against a real Kubernetes API. The panel runs as a pod under ServiceAccount `panel` in `agents`, bound to the exact grants in `deploy/panel/base/rbac.yaml` (sandbox `panel-sandbox-runs`, agents `panel-agents-viewer`), so in-cluster config, TLS trust, and RBAC are all exercised. CI runs it in the `panel-e2e` job on a kind cluster.

| Check | Expectation |
| --- | --- |
| Identity | `kubectl auth can-i` as `panel` matches production: create/list/delete Jobs and get/list/patch CronJobs in `sandbox`, get Services in `agents`; Job watch, CronJob create/delete, and secrets denied |
| Listing | `GET /api/state` returns the seeded sandbox Job and CronJob |
| Auth | a mutation without a bearer token returns 401 and changes nothing |
| Schedules | `PATCH /api/cronjobs/:name` resumes and re-suspends the seeded CronJob |
| Cleanup | `DELETE /api/jobs/:name` removes the seeded Job |
| No launcher | `POST /api/jobs` returns 404 and creates nothing |

RBAC is probed before the panel starts, and non-200 responses print the upstream error with a certificate/forbidden hint. The panel pod gets a one-run bearer token through Secret `panel-e2e-auth`, shaped like `panel-auth`.

## Run

```sh
./scripts/panel-e2e-smoke.sh                     # kind cluster panel-e2e, deleted on exit
PANEL_E2E_KEEP=1 ./scripts/panel-e2e-smoke.sh    # keep fixtures and cluster
```

Needs `docker`, `kind`, `kubectl`, `node`, `curl`. The script builds the panel image and a fixture image for the seeded Job and CronJob (`apps/panel/tests/integration/runner.Dockerfile`), creates or reuses the kind cluster, and drives the panel through a port-forward. On a reused cluster it deletes only what it created.

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
| `PANEL_E2E_KEEP` | `0` | keep fixtures and cluster |
| `PANEL_E2E_PORT` | `3933` | host port for the port-forward |
| `PANEL_E2E_TIMEOUT` | `600` | driver budget in seconds |
| `PANEL_E2E_PANEL_IMAGE` | `panel-e2e:local` | panel image |
| `PANEL_E2E_RUNNER_IMAGE` | `panel-e2e-runner:local` | fixture image |

## Driver only

The assertions live in `apps/panel/tests/integration/panel-e2e.test.mjs`. They suspend and resume `PANEL_E2E_CRONJOB` and delete `PANEL_E2E_SEED_JOB`, so point them only at disposable fixtures:

```sh
PANEL_E2E_URL=http://127.0.0.1:3933 \
PANEL_E2E_NS=sandbox \
PANEL_E2E_SEED_JOB=<a-disposable-job> \
PANEL_E2E_CRONJOB=<a-disposable-suspended-cronjob> \
PANEL_E2E_TOKEN=<a-token-from-the-panel's-tokens-file> \
  node --test apps/panel/tests/integration/panel-e2e.test.mjs
```

Without `PANEL_E2E_URL` every test skips, so `npm test` stays fast.
