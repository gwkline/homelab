# Panel e2e

`scripts/panel-e2e-smoke.sh` tests the panel against a real Kubernetes API. The panel runs as a pod under ServiceAccount `panel` in `agents`, bound by the manifests it ships with (`deploy/panel/base/rbac.yaml` and `cluster-reader.yaml`, applied as-is), so in-cluster config, TLS trust, and RBAC are all exercised. CI runs it in the `panel-e2e` job on a kind cluster.

| Check | Expectation |
| --- | --- |
| Identity | `kubectl auth can-i` as `panel`: create/list/delete Jobs and get/list/patch CronJobs in `sandbox`, get Services and the panel Ingress in `agents`, list nodes and pods cluster-wide; Job watch, CronJob create, node get, and secrets denied |
| Listing | `GET /api/state` returns the seeded sandbox Job and CronJob |
| Cluster | `GET /api/cluster` lists the cluster's nodes and pods |
| Auth | a mutation without a bearer token returns 401 and changes nothing |
| Schedules | `PATCH /api/cronjobs/:name` resumes and re-suspends the seeded CronJob |
| Cleanup | `DELETE /api/jobs/:name` removes the seeded Job |
| No launcher | `POST /api/jobs` returns 404 and creates nothing |

RBAC is probed before the panel starts, and non-200 responses print the upstream error with a certificate/forbidden hint. The panel pod gets a one-run bearer token through Secret `panel-e2e-auth`, shaped like `panel-auth`.

## Run

```sh
./scripts/panel-e2e-smoke.sh                     # kind cluster panel-e2e; deleted on exit if this run created it
PANEL_E2E_KEEP=1 ./scripts/panel-e2e-smoke.sh    # keep fixtures and cluster
```

Needs `docker`, `kind`, `kubectl`, `node`, `curl`. The script builds the panel image and a fixture image for the seeded Job and CronJob (`apps/panel/tests/integration/runner.Dockerfile`), creates the kind cluster `panel-e2e` or reuses it, and drives the panel through a port-forward. In a cluster it found running, it deletes only what it created.

kubectl only ever reads a private kubeconfig written by `kind export kubeconfig`, and the script stops unless that context is `kind-panel-e2e`. Your current context and kubeconfig are never used or changed. With `PANEL_E2E_KEEP=1` the script prints that kubeconfig's path. `apps/panel/tests/e2e-context.test.sh` runs the script against stub tools to prove it.

## Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_E2E_KEEP` | `0` | keep fixtures and cluster |
| `PANEL_E2E_PORT` | `3933` | host port for the port-forward |
| `PANEL_E2E_TIMEOUT` | `600` | driver budget in seconds |
| `PANEL_E2E_PANEL_IMAGE` | `panel-e2e:local` | panel image |
| `PANEL_E2E_RUNNER_IMAGE` | `panel-e2e-runner:local` | fixture image |

## Driver only

The assertions live in `apps/panel/tests/integration/panel-e2e.test.mjs` and use kubectl's current context. They suspend and resume `PANEL_E2E_CRONJOB` and delete `PANEL_E2E_SEED_JOB`, so point them only at disposable fixtures:

```sh
PANEL_E2E_URL=http://127.0.0.1:3933 \
PANEL_E2E_NS=sandbox \
PANEL_E2E_SEED_JOB=<a-disposable-job> \
PANEL_E2E_CRONJOB=<a-disposable-suspended-cronjob> \
PANEL_E2E_TOKEN=<a-token-from-the-panel's-tokens-file> \
  node --test apps/panel/tests/integration/panel-e2e.test.mjs
```

Without `PANEL_E2E_URL` every test skips, so `npm test` stays fast.
