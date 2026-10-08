# Rebuild runbook — bring the cluster back from git

From a Ready k3s server to the full platform, using only this repo and the credentials below. First-time hardware, OS, and k3s setup is [runbook-server-cluster.md](runbook-server-cluster.md).

**Target: fast recovery, not HA.** One k3s server (agent nodes optional) with node-bound local-path PVCs. Nothing is backed up: PVC state is recreated empty.

## 1. Inputs

Only documented sources; anything else you need is a drill finding (section 6).

| Input | Source |
| --- | --- |
| Clean Ubuntu 24.04 host (or a VM running the same scripts) | [runbook-server-cluster.md](runbook-server-cluster.md) steps 1–4 |
| `kubectl` and `helm` on the driver | same, step 4 |
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password; read-only on vault `homelab`. Entered via env or stdin only |
| Everything else (GitHub tokens and App, Tailscale OAuth, model key, Postgres role passwords, Grafana, knowledge credentials) | synced from vault `homelab` by ESO. Every item in [secrets-inventory.md](secrets-inventory.md) must exist before 3.6, or its ExternalSecret stays not Ready and 3.8 fails |

## 2. Pinned versions

| Component | Version | Pinned in |
| --- | --- | --- |
| k3s | `v1.36.4+k3s1` | `bootstrap/bootstrap.sh` (`K3S_VERSION`, sha256-verified installer) |
| tailscaled | `1.102.4` | `bootstrap/bootstrap.sh` (`TAILSCALE_VERSION`, sha256-verified installer) |
| External Secrets Operator | chart 2.10.0 (vendored render) | `deploy/eso/base/eso.yaml` |
| CloudNativePG | 1.30.0 | `deploy/cnpg/base` |
| Sigstore policy-controller chart | `0.10.7` | this runbook, `scripts/recovery-drill.sh` |
| Tailscale operator chart | `1.102.3` | this runbook, `scripts/recovery-drill.sh`, `deploy/tailscale/values.yaml` |

Upgrading k3s/Tailscale: [runbook-server-cluster.md](runbook-server-cluster.md#upgrading-pinned-k3s--tailscale).

## 3. Procedure

Run from the repo root with `KUBECONFIG` pointing at the new cluster. `scripts/recovery-drill.sh` runs steps 3.2–3.8 and times each (section 4).

### 3.1 Node

```sh
date +%s                                  # DRILL_START, if timing a drill
git clone https://github.com/gwkline/homelab.git && cd homelab
./bootstrap/bootstrap.sh server
```

Fetch the kubeconfig to the driver ([runbook-server-cluster.md](runbook-server-cluster.md) step 4) and confirm `kubectl get nodes` is Ready. Join agent nodes now or later.

The server must come back on the address in `clusters/home/node/node.yaml` (its DHCP reservation). Otherwise update that file before the core set, or the API allowances in the NetworkPolicies point at the old address: `kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes` shows the live one. `scripts/rebuild-check.sh` (3.8) compares them.

### 3.2 External Secrets Operator

Server-side apply (two CRDs exceed the client-side annotation limit):

```sh
kubectl apply --server-side -k deploy/eso/base
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/clustersecretstores.external-secrets.io
kubectl -n external-secrets rollout status deploy/external-secrets-webhook
kubectl -n external-secrets rollout status deploy/external-secrets
```

### 3.3 Bootstrap secrets

```sh
kubectl apply -k deploy/namespaces
./scripts/create-onepassword-service-account.sh   # external-secrets only; the ClusterSecretStore reads it
```

That is the only hand-entered secret. Everything else, including the Postgres owner-role passwords (items `knowledge-db`, `factory-db`), syncs from 1Password with the core set ([secrets-inventory.md](secrets-inventory.md)).

### 3.4 Image admission

Must be serving before workloads are admitted ([ADR-004](adr/adr-004-cosign-admission-verification.md), break-glass in [deploy/image-policy/README.md](../deploy/image-policy/README.md)):

```sh
helm repo add sigstore https://sigstore.github.io/helm-charts
helm upgrade --install policy-controller sigstore/policy-controller \
  --version 0.10.7 -n cosign-system --create-namespace
kubectl -n cosign-system rollout status deploy/policy-controller-webhook
```

### 3.5 CloudNativePG

```sh
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io --timeout=180s
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager
```

### 3.6 Core set

```sh
kubectl apply -k clusters/home
```

Namespaces, policies, the ClusterImagePolicy, the ClusterSecretStore and every ExternalSecret, postgres, the metrics and logging stack (VictoriaMetrics, Loki, Grafana), and every core workload, in dependency order ([clusters/home/README.md](../clusters/home/README.md)). Preview with `kubectl kustomize clusters/home`. From here `deploy/deployer` keeps homelab images current every 5 minutes.

### 3.7 Tailscale operator

After the core set, which syncs Secret `operator-oauth`. OAuth values are never passed to helm:

```sh
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --version 1.102.3 -n tailscale --create-namespace \
  -f deploy/tailscale/values.yaml
kubectl apply -f deploy/tailscale/proxyclass.yaml   # default ProxyClass; proxies wait for it
kubectl get ingress -A   # every UI gets <host>.<tailnet>.ts.net
```

Every operator namespace now exists, so apply their default-deny ingress policies (webhook ports stay open to the API server):

```sh
kubectl apply -k deploy/operator-policies/base
```

### 3.8 Verify

```sh
./scripts/rebuild-check.sh --phase cluster
```

It fails on any of these:

- an unreachable API server;
- a `kubectl diff` error, or drift;
- a node under pressure or off the pinned k3s version;
- an API endpoint that isn't the node IP in `clusters/home/node/node.yaml`;
- a Deployment or StatefulSet not ready;
- policy-controller unavailable;
- a secret store or ExternalSecret not Ready;
- pg-primary unhealthy;
- no deployer success in 15 minutes;
- a tailnet UI not answering HTTPS.

It also lists live objects the repo doesn't define, as a report rather than a failure. After 3.10, `./scripts/rebuild-check.sh` (all phases) adds the checks that need the manual steps.

### 3.9 Components outside the core set

Apply as needed; each README lists its prerequisites:

```sh
kubectl apply -k deploy/executor/base     # optional Secret executor-admin
kubectl apply -k deploy/knowledge/base    # needs 1Password knowledge-db / knowledge-api-token
```

Then prove postgres: `scripts/pg-smoke.sh seed && scripts/pg-smoke.sh restart && scripts/pg-smoke.sh verify`.

### 3.10 Recreated state

| Item | Action |
| --- | --- |
| t3code | pairing URL from `kubectl logs t3code-0 -n agents \| head`; pair from desktop/phone; repos re-clone |
| hermes | `kubectl exec -it hermes-0 -n agents -- hermes setup --portal`, then `kubectl rollout restart statefulset hermes -n agents`; message it and get a reply |
| CLI logins (Claude, Codex) | log in again inside hermes/t3code (PVC homes start empty) |
| homepage tailnet links | `kubectl -n agents create configmap homepage-env --from-literal=tailnet-name=<tailnet>.ts.net` ([deploy/tailscale/README.md](../deploy/tailscale/README.md#tailnet-dns-suffix)) |
| panel, homepage | open both over HTTPS; links resolve |

Then `./scripts/rebuild-check.sh --phase manual` (the hermes gateway is running).

## 4. Timed drill

```sh
./scripts/recovery-drill.sh --from "$DRILL_START"   # prompts for the 1Password token unless OP_SERVICE_ACCOUNT_TOKEN is set
```

Runs and times: ESO → namespaces + 1Password token → image policy → CNPG → core set → Tailscale operator and operator-namespace policies → pods ready → tailnet HTTPS → first deployer success → `rebuild-check.sh --phase cluster`, then prints per-stage times and total RTO. Any failed stage fails the drill. It stops at the cluster phase: 3.10 needs a human, so time it separately as the manual phase.

## 5. Drill log

RTO = wall-clock from `DRILL_START` to all section-3 checks green. RPO is "n/a — recreated".

| Run | Date | Machine | RTO total | RTO cluster phase | Manual steps | Follow-ups |
| --- | --- | --- | --- | --- | --- | --- |
| template | YYYY-MM-DD | bare / VM | mm:ss | mm:ss | … | … |

No completed runs yet. After two clean runs, set **target RTO = median × 1.5, rounded up to 5 minutes** here; a drill over target means fixing the slow stage or revising the target with evidence.

## 6. Manual interventions

Every undocumented step during a drill becomes a step in this runbook or a tracked issue before the next run. Known manual steps: the 1Password token (3.3), and hermes portal setup, t3code pairing and CLI logins (3.10). CloudBeaver's read-only connection credentials are typed into its UI ([deploy/cloudbeaver/README.md](../deploy/cloudbeaver/README.md)), and Executor (3.9) lists its admin and client tokens in its README.
