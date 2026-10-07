# Rebuild Runbook — timed fast-recovery drill

**Goal:** from a clean Ubuntu 24.04 machine (or a representative VM running the same scripts and manifests), rebuild the whole platform from Git plus documented external credentials, and measure how long it actually takes.

**Current target: fast recovery on one physical machine — not HA.** The cluster is a single k3s server with node-bound local-path PVCs. Nothing here promises uptime through a host failure; the optimized metric is how quickly one operator can bring everything back. High availability is explicitly out of scope until fast recovery is boring (roadmap #94).

**Status:** drill procedure implemented (issue #34). First timed run pending — see [Drill log](#drill-log-actual-rto--rpo).

---

## 1. Prerequisites (documented sources only)

Everything the drill starts from must be in this list. If you reach for anything else — a file from the old node, a secret from a running pod, a config not written down — that is a drill finding: it becomes a runbook step or a follow-up issue before the next run.

- Clean Ubuntu 24.04 host **or a VM** (a VM drill is acceptable before wiping the physical host, but it must exercise these exact scripts and manifests), with OpenSSH installed per [runbook-server-cluster](runbook-server-cluster.md) §0–2.
- Physical host only: `nomodeset` in the kernel cmdline (§3 below) so headless reboots survive.
- This repo checked out on the machine or the driver box.
- `kubectl` and `helm` available where the drill runs (server runbook §4–5).
- Credentials, all from documented external sources (never from the old cluster):

| Credential | Source |
| --- | --- |
| 1Password service-account token (`OP_SERVICE_ACCOUNT_TOKEN`) | 1Password `homelab` vault — least-privilege SA token (issue #41); entered via env/stdin only |
| GitHub tokens | 1Password items `github-readonly` / `github-writer`; synced by the root entry point `kubectl apply -k clusters/home` (issue #45; standalone: `deploy/github-tokens/base/README.md`) |
| Tailscale OAuth (`TS_CLIENT_ID` / `TS_CLIENT_SECRET`) | macOS Keychain `homelab-tailscale`; tag `tag:k8s-operator` must exist on the OAuth client ([deploy/tailscale/README.md](../deploy/tailscale/README.md)) |

No hidden state is copied from the existing cluster. The only crossers are the documented channels above. Nothing is backed up: PVC state is recreated (section 4, step 2).

## 2. Pinned versions used by the drill

| Component | Version | Where it is pinned |
| --- | --- | --- |
| k3s | `v1.36.4+k3s1` | `bootstrap/bootstrap.sh` default (`K3S_VERSION`; installer sha256-verified, upgrade procedure: §2a) |
| Tailscale operator chart | `1.102.3` | `scripts/recovery-drill.sh` (`TS_CHART_VERSION`); the PROXY_TAGS workaround in [deploy/tailscale/README.md](../deploy/tailscale/README.md) is tested against this chart |
| Sigstore policy-controller chart | `0.10.7` | `scripts/recovery-drill.sh` (`POLICY_CHART_VERSION`); the ClusterImagePolicy it verifies against lives in [deploy/image-policy/base](../deploy/image-policy/base/README.md) (issue #91, ADR-004) |
| tailscaled (host package) | `1.102.4` | `bootstrap/bootstrap.sh` default (`TAILSCALE_VERSION`; installer sha256-verified, upgrade procedure: §2a) |

`bootstrap/bootstrap.sh` is the root node entry point; `clusters/home` is the root cluster entry point (issue #20): one Kustomization composing namespaces, policies, platform prerequisites, and workloads with the dependency contract documented in [clusters/home/README.md](../clusters/home/README.md). `scripts/recovery-drill.sh` times that same order stage by stage.

Both bootstrap installers are content-verified (issue #29): the script downloads each installer from its immutable version tag on GitHub and refuses to execute it unless its sha256 matches the value pinned beside the version. Bootstrap validates the platform contract (Ubuntu 24.04, amd64 or arm64) and fails fast otherwise. **Changing a pin means changing the version and its recorded installer sha256 together** — never edit one without the other.

### §2a. Upgrading a pinned bootstrap version (deliberate, tested — never automatic)

1. Pick the new version and record its installer sha256 from the immutable tag:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/k3s-io/k3s/<new-tag>/install.sh | sha256sum
   curl -fsSL https://raw.githubusercontent.com/tailscale/tailscale/v<new>/scripts/installer.sh | sha256sum
   ```

2. Update both constants together in `bootstrap/bootstrap.sh` (`K3S_VERSION` + `K3S_INSTALLER_SHA256`, `TAILSCALE_VERSION` + `TAILSCALE_INSTALLER_SHA256`). The env overrides exist so an existing node can be upgraded deliberately without editing the repo first.
3. Re-run the node bootstrap on one node (`./bootstrap/bootstrap.sh server` — the k3s installer is upgrade-aware) and record the installed versions (`k3s --version`, `tailscale version`) in the drill log.
4. Run the cluster smoke tests before trusting the upgrade: `./scripts/rebuild-check.sh`, then one timed drill pass (`./scripts/recovery-drill.sh --from "$(date +%s)"`) per section 4.
5. Reproducibility check: bootstrap a disposable VM twice from the same revision and confirm both runs report identical `k3s --version` and `tailscale version` output.

## 3. Node prerequisites (physical host only)

1. `/etc/default/grub`: `GRUB_CMDLINE_LINUX_DEFAULT="quiet splash nomodeset"`
2. `sudo update-grub`, then verify: `sudo grep -c nomodeset /boot/grub/grub.cfg` → must be ≥1 (verify with sudo — a user-level grep showing 0 may just mean permission, but confirm before relying on headless reboots)
3. k3s running (`systemctl status k3s`), tailscale up.

## 4. Timed drill procedure

### Step 0 — node bootstrap (interactive; start the clock here)

Record the drill-start timestamp as your **first command** on the clean machine:

```sh
date +%s   # DRILL_START — this is the RTO start line
git clone https://github.com/gwkline/homelab.git && cd homelab
./bootstrap/bootstrap.sh server          # pins k3s + tailscale per section 2

# 0. node ready per above

# 1. secrets infra: External Secrets Operator (issue #38, pinned in
#    deploy/eso/base) must be Ready before any ExternalSecret applies, then
#    the one hand-entered 1Password bootstrap token (issue #41): the script
#    is idempotent, reads the token from OP_SERVICE_ACCOUNT_TOKEN or stdin
#    (hidden prompt), and never logs it
kubectl apply --server-side -k deploy/eso/base   # 1: CRDs, RBAC, Deployments
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/secretstores.external-secrets.io
kubectl -n external-secrets rollout status deploy/external-secrets
kubectl apply --server-side -k deploy/eso/base   # 2: SecretStore + smoke ExternalSecret
kubectl -n external-secrets wait --for=condition=Ready externalsecret/eso-smoke --timeout=120s
./scripts/create-onepassword-service-account.sh  # Secret onepassword-service-account -> agents, sandbox, work, tailscale
# (github-tokens needs no standalone apply: the root entry point below
# composes deploy/github-tokens/base)

# 2. image admission policy (issue #91 / ADR-004): the sigstore
#     policy-controller webhook must be in force BEFORE the root apply
#     below admits workload pods — it admits pods only when the exact
#     digest of a ghcr.io/gwkline/homelab/** image carries a signature from
#     this repo's CI workflow. Its CRD also defines the ClusterImagePolicy
#     the root composes. Break-glass and failure behavior:
#     deploy/image-policy/base/README.md
helm repo add sigstore https://sigstore.github.io/helm-charts
helm upgrade --install policy-controller sigstore/policy-controller \
  --version 0.10.7 -n cosign-system --create-namespace
kubectl -n cosign-system rollout status deploy/policy-controller-webhook

# 2b. CloudNativePG operator (issue #49): the pinned bundle from git
#     (deploy/cnpg/base) must be Ready before the root applies — the
#     postgres Cluster/Database CRs it composes (deploy/postgres/base)
#     are rejected until the CRDs are Established. One server-side apply
#     carries CRDs, RBAC and the Deployment; plain client-side apply
#     cannot carry the bundle (its Cluster CRD exceeds the annotation
#     size limit). Idempotent — re-running is the recovery path
#     (deploy/cnpg/README.md).
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io --timeout=180s
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager

# 3. the root entry point (issue #20): one render, one apply — namespaces +
#     policies (kubectl apply orders Namespaces first), the
#     ClusterImagePolicy, the github-tokens sync, the tailscale stack
#     (namespace, SecretStore, operator-oauth ExternalSecret), postgres (pg-primary — its cnpg CRDs were
#     Established in 2b), and every normal workload: t3code, hermes,
#     homepage, panel, headlamp, factory, deployer, work-t3code, then the operational CronJobs (chaos, node-cleanup)
#     last so their first run cannot race the bring-up. Full inventory +
#     dependency contract: clusters/home/README.md
kubectl apply -k clusters/home

# 4. tailscale operator: after the root apply — it consumes the
#    operator-oauth Secret the root synced from 1Password; helm with the
#    pinned values file — never --set oauth.* (issue #43)
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --version 1.102.3 -n tailscale --create-namespace \
  -f deploy/tailscale/values.yaml
kubectl -n tailscale set env deploy/operator PROXY_TAGS=tag:k8s-operator  # chart bug workaround (documented)
kubectl rollout restart deploy/operator -n tailscale

# 4b. HTTPS: t3code-0, work-t3code-0 and panel are Tailscale Ingresses; the
# operator provisions their proxies and tailnet certs once it is running.
kubectl get ingress -A   # ADDRESS column = <host>.<tailnet>.ts.net

# 5. wait & verify
kubectl get pods -A -w
# TAILNET_NAME is the one documented tailnet config value
# (deploy/tailscale/README.md).
curl -s -o /dev/null -w "%{http_code}\n" "https://t3code-0.${TAILNET_NAME:-<tailnet>}/"
```

Render the whole normal set without applying anything: `kubectl kustomize clusters/home` — the inventory (134 resources across 5 namespaces) is deterministic and contains no duplicate resource IDs (CI re-checks this in `scripts/verify.sh`).

Fetch the kubeconfig to the driver (server runbook §4), confirm `kubectl get nodes` is Ready, and export the three credentials from section 1.

### Step 1 — cluster bring-up (timed, one command)

```sh
./scripts/recovery-drill.sh --from "$DRILL_START"
```

The script runs and times every stage — operator (pinned chart + PROXY_TAGS workaround), namespaces/policies, image policy (policy-controller + ClusterImagePolicy, before workloads), external secrets (pinned ESO from `deploy/eso/base` + fake-provider smoke, before any ExternalSecret applies), cnpg (pinned CloudNativePG operator from `deploy/cnpg/base`, the explicit prerequisite for the `database` workloads — issue #49), secrets (1Password SA token + github-tokens sync), workloads (postgres, tailscale, t3code, hermes, homepage, panel, headlamp, factory, deployer, work-t3code, then chaos + node-cleanup last — the same set and dependency order the root Kustomization composes), pods-ready, HTTPS (wait for the t3code-0 and panel Ingress hostnames, then curl each), and the `scripts/rebuild-check.sh` smoke sweep — then prints per-stage times and the total RTO. A failed stage fails the drill; the fix must land as a runbook step or follow-up issue before the next attempt (known warnings it emits are listed in section 6).

### Step 2 — PVC state: recreate

Nothing is backed up, so every PVC starts empty: t3code state (repos re-clone, pairing re-runs) and hermes gateway config re-entered by hand. Record in the drill log which workloads' state was recreated or deliberately dropped.

### Step 3 — workload-level checks (manual by design)

- t3code: pairing URL from `kubectl logs t3code-0 -n agents | head` → pair from desktop/phone (inherently interactive).
- hermes: `kubectl exec -it hermes-0 -n agents -- hermes setup --portal` once on a fresh PVC, then `kubectl rollout restart statefulset hermes -n agents`; message it on its channels and get a sane reply.
- panel/homepage: open both over HTTPS; links resolve.

### Step 4 — record

Fill one row in the drill log (section 5), convert every manual surprise (section 6), and update the target RTO (section 7).

## 5. Drill log (actual RTO / RPO)

RTO = wall-clock from the clean machine's first command (`DRILL_START`) to all section-4 checks green. Observed RPO is "n/a — recreated" (nothing is backed up).

| Run | Date | Machine | RTO (total) | RTO (cluster phase) | Observed RPO | PVC decision | Follow-ups filed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| template | YYYY-MM-DD | bare / VM | mm:ss | mm:ss | hh:mm | restored / recreated | #… |

_(No completed runs yet — first timed drill pending. This table is the evidence base for section 7.)_

## 6. Manual interventions → runbook steps or follow-up issues

Rule: every undocumented step you perform during a drill becomes either a runbook step here or a follow-up issue before the next run. Known gaps going into the first drill:

| Finding | Disposition |
| --- | --- |
| External Secrets Operator was not installed by any manifest | closed (issue #38): pinned install in `deploy/eso/base` (runbook-server-cluster §4b); the drill installs it in the `eso` stage before any ExternalSecret apply and smoke-checks the fake-provider ExternalSecret |
| Host tailscaled not version-pinned | closed (issue #29): pinned `TAILSCALE_VERSION` + sha256-verified installer in `bootstrap/bootstrap.sh`; upgrade procedure: §2a |
| Apply order lives in `scripts/recovery-drill.sh` instead of a root Kustomization | closed (issue #20): `clusters/home` root Kustomization is the source of truth (clusters/home/README.md); the drill times the same order stage by stage |
| hermes `hermes setup --portal` re-run after PVC recreation | runbook step (section 4, step 3) |
| t3code pairing from desktop/phone | runbook step (section 4, step 3); durable auth persistence tracked by issue #19 |
| API-level manifest validation before apply (invalid RoleBindings, missing SAs) | follow-up: issue #16 |

## 7. Target RTO

Evidence-based: after at least two clean, successful drill runs on the representative machine, set **target RTO = median of the clean runs × 1.5, rounded up to the next 5 minutes**, and record it here with the run numbers it came from. Every future drill reports against it; a drill exceeding the target reopens this section (either fix the slow stage or revise the target with new evidence).

**Current target RTO: not set — first two measured runs pending.**
