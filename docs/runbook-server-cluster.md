# Server cluster runbook

From bare hardware to a working two-node agent cluster. Everything after Step 3 happens over SSH — no monitor needed once the OS is installed.

Replace throughout:

| Placeholder                 | Meaning                      |
| --------------------------- | ---------------------------- |
| `<user>`                    | your username on the servers |
| `<node1-ip>` / `<node2-ip>` | LAN IPs of server 1 / 2      |
| `<github-user>`             | GitHub username              |

---

## 0. Prerequisites

- 2+ x86_64 machines, 8 GB+ RAM each, a spare 16 GB+ disk each
- A USB stick (4 GB+) per simultaneous install
- A second machine (laptop/desktop) to drive everything from
- Ethernet strongly preferred for servers

## 1. BIOS settings (per machine)

Do this while you still have a monitor attached. Exact names vary by vendor:

- **Restore on AC Power Loss → Power On** (or "Auto Power On") — so machines come back after an outage without you driving across the apartment
- **Boot mode → UEFI** (disable CSM/Legacy)
- Disable **Secure Boot** if present (avoids driver/MOK friction later; optional on Ubuntu but simpler)
- Note the machine's RAM/CPU for capacity planning later

## 2. Install Ubuntu Server 24.04 LTS (per machine)

1. Download `ubuntu-24.04.x-live-server-amd64.iso`
2. Flash to USB: [balenaEtcher](https://etcher.balena.io/) (macOS/Win/Linux) or `dd` if you know it
3. Boot from USB, installer choices:
   - Keyboard/locale: yours
   - Type: **Ubuntu Server** (default, no snap extras needed)
   - Network: leave DHCP for now
   - Storage: **Use entire disk** (no LVM needed for a throwaway node)
   - Profile: name `<user>`, hostname `agent-1` / `agent-2`, your password
   - **[x] Install OpenSSH server** ← the important checkbox
   - Skip all featured snaps
4. Reboot, remove USB. The installer summary screen shows the IP — write it down (`<node1-ip>`). If you miss it, it's also in your router's client list.

## 3. Bootstrap both machines (first SSH, from your laptop)

```sh
ssh <user>@<node1-ip>
```

Then, on the machine:

```sh
# grab the homelab repo and run bootstrap (installs tailscale + k3s)
sudo apt-get install -y git
git clone https://github.com/<github-user>/homelab.git && cd homelab

./bootstrap/bootstrap.sh server             # ONLY on the first machine
```

On the second machine:

```sh
ssh <user>@<node2-ip>
sudo apt-get install -y git
git clone https://github.com/<github-user>/homelab.git && cd homelab

./bootstrap/bootstrap.sh agent <node1-ip>   # prompts for the node token
```

When prompted for the node token, get it from server 1:

```sh
ssh <user>@<node1-ip> sudo cat /var/lib/rancher/k3s/server/node-token
```

Verify from server 1 (or your laptop, next step):

```sh
sudo k3s kubectl get nodes   # both nodes Ready within ~60s
```

## 4. Drive the cluster from your laptop

Install kubectl if you don't have it (macOS: `brew install kubectl`; otherwise see the [official docs](https://kubernetes.io/docs/tasks/tools/)). The kubeconfig is root-only on the node, so fetch it with sudo over SSH:

```sh
ssh <user>@<node1-ip> sudo cat /etc/rancher/k3s/k3s.yaml > ~/kubeconfig-homelab
sed -i '' "s|127.0.0.1|<node1-ip>|" ~/kubeconfig-homelab   # BSD/macOS sed
export KUBECONFIG=~/kubeconfig-homelab                     # add to shell rc
kubectl get nodes
```

(Windows/Linux: use `sed -i "s|..."` without the `''`.)

## 4b. External Secrets Operator (cluster prerequisite)

Everything that syncs a Secret — the Tailscale OAuth client (section 5), GitHub tokens (section 6) — needs the External Secrets Operator ready first, so install it before any of those steps. `deploy/eso/base` is the pinned install (Helm chart `external-secrets` 2.10.0 rendered to plain YAML with a digest-pinned controller image; CRDs use the supported `external-secrets.io/v1` APIs; the controller runs non-root with bounded resources). The apply is idempotent — re-running it is the recovery path. Full pins, upgrade, and uninstall notes: deploy/eso/base/README.md.

```sh
kubectl apply --server-side -k deploy/eso/base   # 1: CRDs, RBAC, Deployments
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/secretstores.external-secrets.io
kubectl -n external-secrets rollout status deploy/external-secrets
kubectl -n external-secrets rollout status deploy/external-secrets-webhook
kubectl -n external-secrets rollout status deploy/external-secrets-cert-controller
kubectl apply --server-side -k deploy/eso/base   # 2: SecretStore + smoke ExternalSecret
kubectl -n external-secrets wait --for=condition=Ready externalsecret/eso-smoke --timeout=120s
kubectl -n external-secrets get secret eso-smoke-output -o jsonpath='{.data.password}' | base64 -d
# expect: eso-smoke-ok — fake-provider smoke, proves reconciliation without credentials
```

Do not apply any `SecretStore`/`ExternalSecret` (sections 5, 6, 11) before the controller rollout is Ready — those objects stay Pending until the CRDs and webhook are up.

## 5. Tailscale operator (tailnet HTTPS for services)

Prerequisite: External Secrets Operator is ready (section 4b) and the 1Password service-account token exists in the `tailscale` namespace (section 6 / issue #41).

1. Generate an OAuth client at https://login.tailscale.com/admin/settings/oauth — Devices/Core + Auth Keys read-or-modify, Routes read, and it must be created WITH the `tag:k8s-operator` tag. Store it as the `client_id` / `client_secret` fields of the `tailscale-operator-oauth` item in the `homelab` vault (item contract: deploy/tailscale/README.md).
2. Install Helm anywhere kubectl works:

```sh
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm repo add tailscale https://pkgs.tailscale.com/helmcharts && helm repo update

kubectl apply -k deploy/tailscale   # namespace + SecretStore + ExternalSecret -> Secret operator-oauth
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --version 1.102.3 \
  --namespace tailscale --create-namespace \
  -f deploy/tailscale/values.yaml   # references Secret operator-oauth; never --set oauth.* (issue #43)
```

Rotation procedure (keeps existing proxy devices): deploy/tailscale/README.md.

## 6. Secrets (private repo access)

GitHub tokens are synced from 1Password by External Secrets Operator (installed in section 4b) — nothing is created by hand except the least-privilege 1Password service-account token (restricted to the `homelab` vault, issue #41).

Fine-grained PAT: https://github.com/settings/personal-access-tokens/new → Repository access: pick your repos → Permissions: Contents **Read-only**. Store it as the `token` field of the `github-readonly` item in the `homelab` vault (optionally `github-writer` for write-scoped jobs), then:

```sh
kubectl apply -k deploy/github-tokens/base   # item contract + rotation: deploy/github-tokens/base/README.md
```

## 7. Make images pullable

CI built `ghcr.io/<github-user>/homelab/{t3code,loop-agent,hermes}` on push (check the Actions tab). Either:

- **Easy**: github.com → your profile → Packages → each package → Package settings → Change visibility → Public, **or**
- Private: create pull secrets per namespace (see main README).

If the StatefulSet pods sit in `ImagePullBackoff`, this is why.

## 8. Deploy everything

The root cluster entry point (issue #20) composes the normal set in one command — `kubectl apply -k clusters/home`, after the ESO + cnpg server-side pre-applies (dependency contract: [clusters/home/README.md](../clusters/home/README.md)). The per-component list below is the manual equivalent and also carries the opt-in components (cloudbeaver, loki, …) the root deliberately leaves out.

```sh
kubectl apply --server-side -k deploy/eso/base   # section 4b — idempotent re-apply of the pinned operator (server-side: two of its CRDs exceed the client-side annotation size limit)
kubectl apply -k deploy/namespaces
kubectl apply -k deploy/policies/base
kubectl apply -k deploy/t3code/base
kubectl apply -k deploy/hermes/base
kubectl apply -k deploy/homepage/base
kubectl apply -k deploy/panel/base
kubectl apply -k deploy/headlamp/base
kubectl apply -k deploy/cloudbeaver/base
kubectl apply -k deploy/loki/base

# Weekly node-cleanup CronJob (#252): sweeps Evicted pods + Succeeded pods
# older than 24h across namespaces. The containerd image prune half of
# scripts/node-cleanup.sh needs the node itself — schedule the script with a
# crontab there too (see deploy/node-cleanup/base/README.md).
kubectl apply -k deploy/node-cleanup/base

# CloudNativePG operator (issue #49) — explicit prerequisite for the database
# below: CRDs + RBAC + controller in one idempotent server-side apply. Wait
# for the CRD and the rollout before any Cluster resource applies (the
# admission webhooks fail closed until serving). Install/upgrade/CRD-ordering
# contract: deploy/cnpg/README.md.
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager

# database (prereqs: CNPG operator from #49 in cnpg-system, pg-textsearch
# digest from #48 pinned in deploy/postgres/base/cluster.yaml — see
# deploy/postgres/README.md for secrets and bring-up)
kubectl apply -k deploy/postgres/base

kubectl get pods -A -w    # watch it settle; ^C when Running
```

## 9. First contact

**postgres** (durable state for factory + knowledge):

```sh
kubectl get cluster -n database pg-primary      # "Cluster in healthy state"
scripts/pg-smoke.sh seed && scripts/pg-smoke.sh restart && scripts/pg-smoke.sh verify
```

**t3code** (interactive coding agents):

```sh
kubectl get svc -n agents                 # find t3code-0 tailnet hostname
kubectl logs t3code-0 -n agents | head    # pairing URL
# open URL from desktop app/phone; add projects via configmap + restart pod
```

**hermes** (orchestrator):

```sh
kubectl exec -it hermes-0 -n agents -- bash
hermes setup --portal      # one-time: provider/model/gateway config
exit
kubectl rollout restart statefulset hermes -n agents
# message it on Telegram/Discord: "what can you see in the cluster?"
```

**homepage** (dashboard):

```sh
kubectl get svc homepage -n agents   # tailnet hostname
# edit deploy/homepage/base/configmap.yaml to add services, then re-apply
```

**panel** (factory control panel):

```sh
kubectl get ingress panel -n agents  # tailnet hostname
# open it: launch runs, watch jobs. Set your tailnet in
# deploy/homepage/base/configmap.yaml to link it from the dashboard
```

**headlamp** (Kubernetes web UI, read-only):

```sh
kubectl get svc headlamp -n agents   # tailnet hostname
# open it: inspect workloads, events, logs, metrics — see
# deploy/headlamp/base/README.md for the RBAC + access contract
```

**cloudbeaver** (database GUI, tailnet-only):

```sh
./scripts/create-cloudbeaver-secret.sh agents   # paste least-privilege DB creds from your password manager
kubectl get svc cloudbeaver -n agents           # tailnet hostname
# open it: create the admin user, then open the Factory PostgreSQL connection
# with the role from Secret cloudbeaver-db (see deploy/cloudbeaver/base/README.md)
```

## 10. When a node dies

```sh
# reinstall OS (steps 2), then:
./bootstrap/bootstrap.sh agent <node1-ip>   # same token, same cluster
```

PVC data on the dead node is gone by definition — everything else converges from git. For t3code repos: they re-clone automatically. Unpushed work in an agent workspace is unrecoverable, which is the deal you signed up for.

## Troubleshooting quick hits

| Symptom | Fix |
| --- | --- |
| `ImagePullBackoff` | Section 7 |
| t3code pairing fails over tailnet | check NetworkPolicy allowed tailscale ns |
| Job logs gone after TTL deletion | query Loki instead (Section 12): `{job_name="<job>"}` |
| Node NotReady after reboot | `sudo systemctl status k3s` on that node |
| Clone fails on private repo | 1Password `github-readonly` item expired or missing repo access (Section 6) |

## 11. Backups

Nothing is backed up. State lives on PVCs (lost with their node, see section 10) and in 1Password.

## 12. Logs in Loki

Every pod's logs are collected by Alloy and stored in Loki (`deploy/loki/base`) with bounded labels — `namespace`, `workload`, `profile`, `job_name` (the run identifier), `pod`, `container`. Retention is 30 days, so a sandbox Job remains debuggable for weeks after `ttlSecondsAfterFinished` deletes its pods and `kubectl logs` stops working. Credentials (auth headers, GitHub/model tokens) are redacted at source. Full details: `deploy/loki/README.md`.

Deploy (already part of Section 8) and verify the whole chain with one uniquely identified run:

```sh
kubectl apply -k deploy/loki/base
./scripts/new-job.sh loki-smoke 'echo hello-from-run-$RANDOM'
kubectl wait --for=condition=complete job/loki-smoke -n sandbox --timeout=180s
kubectl delete job loki-smoke -n sandbox          # pod + kubectl logs gone

kubectl port-forward svc/loki -n agents 3100:3100 &
curl -s 'http://localhost:3100/loki/api/v1/query_range' \
  --get --data-urlencode 'query={namespace="sandbox", job_name="loki-smoke"}'
```

The response contains the run's output. In Grafana (tailnet hostname, Section 9's dev-tools catalog), Explore on the provisioned Loki datasource takes the same query — and the datasource's derived fields turn any `job_name="…"` in a log line into a click-through to that run's logs.

Disk discipline: 10Gi PVC hard ceiling, 30-day retention. If Loki starts refusing writes, the PVC is full — lower `retention_period` in `deploy/loki/base/loki.yaml` or grow the PVC. Logs are not backed up (disposable by design).
