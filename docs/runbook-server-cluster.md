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

## 5. Tailscale operator (tailnet HTTPS for services)

1. Log into https://login.tailscale.com/admin/settings/oauth → generate an OAuth client (no extra scopes needed)
2. Install Helm anywhere kubectl works:

```sh
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm repo add tailscale https://pkgs.tailscale.com/helmcharts && helm repo update

helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale --create-namespace \
  --set-string oauth.clientId="<CLIENT_ID>" \
  --set-string oauth.clientSecret="<CLIENT_SECRET>"
```

## 6. Secrets (private repo access)

GitHub tokens are synced from 1Password by External Secrets Operator — nothing is created by hand except the least-privilege 1Password service-account token (restricted to the `homelab` vault, issue #41). `scripts/create-github-secret.sh` is deprecated.

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

```sh
kubectl apply -f deploy/namespaces.yaml
kubectl apply -k deploy/policies/base
kubectl apply -k deploy/t3code/base
kubectl apply -k deploy/hermes/base
kubectl apply -k deploy/loop-agent/base
kubectl apply -k deploy/homepage/base
kubectl apply -k deploy/panel/base
kubectl apply -k deploy/headlamp/base
kubectl apply -k deploy/cloudbeaver/base

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

**loop-agent** (throwaway jobs):

```sh
kubectl create job --from=cronjob/loop-example smoke-test -n sandbox
kubectl logs job/smoke-test -n sandbox -f
```

**homepage** (dashboard):

```sh
kubectl get svc homepage -n agents   # tailnet hostname
# edit deploy/homepage/base/configmap.yaml to add services, then re-apply
```

**panel** (factory control panel):

```sh
kubectl get svc panel -n agents      # tailnet hostname
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

**dispatcher** (optional, issue-driven runs): requires hermes' RBAC (applied above) and a PAT in secret `github-token` for API reads. Edit the repo and command in `deploy/dispatcher/base/cronjob.yaml`, then:

```sh
kubectl apply -k deploy/dispatcher/base
# label any issue `run-agent` in the watched repo -> Job appears in sandbox
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
| Pod `CreateContainerError` privileged | workload landed in wrong namespace |
| t3code pairing fails over tailnet | check NetworkPolicy allowed tailscale ns |
| Node NotReady after reboot | `sudo systemctl status k3s` on that node |
| Clone fails on private repo | 1Password `github-readonly` item expired or missing repo access (Section 6) |

## 11. Nightly backups (off until you enable them)

PVC data (agent home dirs, t3code's own state, hermes memory) is backed up encrypted to object storage every night at 03:30. **RPO: 24 hours** — a worst-case disaster loses at most the last day of PVC changes. Git repos inside the workspaces are skipped from preciousness (they re-clone); everything else on the three PVCs is in scope. Nothing runs until the steps below are done.

The backup job runs in the `agents` namespace, next to the PVCs it reads — PVCs cannot be mounted across namespaces. Credentials live in the homelab vault in 1Password; the cluster only ever holds a synced copy.

### One-time setup (human steps, ~10 minutes)

1. **Private B2 bucket**: Backblaze → Buckets → Create Bucket. Keep **Private**; note the bucket name and region. No public access, no lifecycle rules.
2. **Least-privilege application key**: Backblaze → Application Keys → Add a New Application Key. Cap it to **the bucket above only**, capabilities Read and Write. The `keyID` + `applicationKey` pair is shown once — copy it straight into the 1Password item below. Never paste it into this repo, an issue, or a log.
3. **1Password item `restic-backup`** in the homelab vault with four text fields named exactly: `RESTIC_REPOSITORY` (e.g. `b2:<bucket-name>/homelab`), `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`, `RESTIC_PASSWORD` (invent a long one). Values are entered only in 1Password — never in git, issues, or logs. **`RESTIC_PASSWORD` has its only authoritative copy here; losing it loses every backup.**
4. **Recovery metadata**: add a Notes section to the same item with the bucket name + region, repository path, creation date, the RPO (24h), the restic image version in use (`restic/restic:0.18.0`), and a pointer to this section. On a completely fresh machine, this one item is all you need to get the data back (see _Recovering on a completely fresh machine_ below).

### Enable

External Secrets Operator must be installed and connected to the vault (service-account token bootstrapped, store healthy — the `onepassword` SecretStore in `agents` comes from `deploy/github-tokens/base`, nothing extra to apply). Then:

```sh
kubectl apply -k deploy/backup/base
kubectl get externalsecret backup-target -n agents   # must show SecretSynced=True
```

Applying the directory materializes Secret `backup-target` in `agents` with the exact keys the restic CronJob reads via `envFrom`, and schedules the job at 03:30 nightly.

### First backup and verification drill

Trigger a one-off run immediately (don't wait for 03:30):

```sh
kubectl create job --from=cronjob/restic-backup backup-drill -n agents
kubectl -n agents wait --for=condition=complete job/backup-drill --timeout=30m
kubectl -n agents logs job/backup-drill | grep -E '==>|added to the repo|pruned'
kubectl -n agents delete job backup-drill
```

The log shows `==> backing up` for `/mnt/t3code`, `/mnt/t3state`, and `/mnt/hermes`, then `==> backup complete`. The first run ever also initializes the repository; every run (including this one-off) applies retention and prunes — the forget/prune summary is in the same log.

List the snapshots and capture the output — IDs, tags, timestamps only, no file contents:

```sh
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: backup-snapshots
  namespace: agents
spec:
  backoffLimit: 1
  template:
    metadata:
      labels:
        app: backup-snapshots
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: restic
          image: restic/restic:0.18.0
          command: ["restic", "snapshots"]
          envFrom:
            - secretRef:
                name: backup-target
          resources:
            requests:
              cpu: "100m"
              memory: 128Mi
            limits:
              memory: 512Mi
EOF
kubectl -n agents wait --for=condition=complete job/backup-snapshots --timeout=5m
kubectl -n agents logs job/backup-snapshots
kubectl -n agents delete job backup-snapshots
```

Expect one snapshot per source, each separately identifiable by its tag: `t3code`, `t3state`, `hermes`.

### Scratch restore drill (prove files are readable)

A successful backup is not a backup until you have read files back. Restore the latest snapshot of each source into scratch storage — an `emptyDir` that dies with the job, so live PVCs are never touched. The size limit equals the sum of the PVC capacities, so even a full restore always fits:

```sh
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: scratch-restore
  namespace: agents
spec:
  backoffLimit: 1
  template:
    metadata:
      labels:
        app: scratch-restore
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: restic
          image: restic/restic:0.18.0
          command: ["sh", "-c"]
          args:
            - |
              set -eu
              restic restore --tag t3code  latest --target /restore
              restic restore --tag t3state latest --target /restore
              restic restore --tag hermes  latest --target /restore
              echo "restored $(find /restore -type f | wc -l) files into scratch"
              for marker in \
                /restore/mnt/t3code/repos/homelab/README.md \
                /restore/mnt/hermes/hermes/skills-sync/status.json \
                /restore/mnt/t3state/environment-id; do
                [ -s "$marker" ] || { echo "MISSING marker: $marker"; exit 1; }
                echo "marker ok: $marker"
              done
          envFrom:
            - secretRef:
                name: backup-target
          volumeMounts:
            - name: scratch
              mountPath: /restore
          resources:
            requests:
              cpu: "200m"
              memory: 256Mi
            limits:
              memory: 1Gi
      volumes:
        - name: scratch
          emptyDir:
            sizeLimit: 45Gi   # t3code 20 + t3state 5 + hermes 20 — actual usage is far less
EOF
kubectl -n agents wait --for=condition=complete job/scratch-restore --timeout=30m
kubectl -n agents logs job/scratch-restore | grep -E 'restored|marker'
kubectl -n agents delete job scratch-restore
```

The three markers are known non-secret files, one per source: the homelab repo's `README.md` (agent home dirs), `skills-sync/status.json` (hermes memory metadata), and `environment-id` (t3code's environment identifier — a UUID, not a credential). For proof beyond existence, `kubectl exec` into an interactive pod with the same scratch mount and `cat` exactly those three files — never anything else from the restored tree (it contains session tokens and private memory), and never into a ticket or log. The drill never overwrites live PVCs: it restores into an `emptyDir` that dies with the job.

### Rotation and replacement

- **B2 keyID / applicationKey**: rotate in Backblaze, then update the two fields in the 1Password item. The Secret re-syncs within the hour (`refreshInterval: 1h`); the next nightly run picks up the new key. Nothing else to do — the repository is not tied to a specific key.
- **`RESTIC_PASSWORD` is different.** It is the encryption password of the restic repository. Changing the field in 1Password does NOT change the repository's password — it only makes restic present the wrong one: nightly backups fail with a wrong-password error, and existing snapshots cannot be restored until the field is corrected. To actually rotate the repository password, run `restic key passwd` against the repository first (with the old password still in place), then set the field in 1Password to the new value. If the real password is ever lost outright, every existing snapshot is unrecoverable — that is why its only authoritative copy lives in 1Password, outside the cluster.
- **Recovering a bad sync**: fix the fields in the 1Password item and let the refresh converge, or force it immediately by deleting the generated Secret (`kubectl delete secret backup-target -n agents`) — ESO recreates it from the vault. Because the ExternalSecret uses `creationPolicy: Owner`, hand edits to `backup-target` are also reconciled back to the vault state within the refresh interval.

### Retention

The backup job prunes on every run: `restic forget --keep-daily 7 --keep-weekly 5 --keep-monthly 6 --prune`. That keeps the last 7 daily, 5 weekly, and 6 monthly snapshots per source and deletes unreferenced data from B2, so storage cost stays bounded. To change the policy, edit `deploy/backup/base/cronjob.yaml` and re-apply; to see what a change would delete without deleting, run `restic forget --keep-daily 7 --keep-weekly 5 --keep-monthly 6 --dry-run` in a `backup-snapshots`-style job.

### Recovering on a completely fresh machine

If the whole cluster is gone, this is the entire recovery path — no cluster needed to read the data back:

1. Install the 1Password CLI (`op`) and sign in. Everything you need is in item `restic-backup` of the homelab vault: the four secret fields below, plus the Notes section (bucket, region, RPO, restic version).
2. Pull the credentials into the environment — the 1Password CLI keeps values out of shell history and logs:

```sh
export RESTIC_REPOSITORY="$(op read 'op://homelab/restic-backup/RESTIC_REPOSITORY')"
export B2_ACCOUNT_ID="$(op read 'op://homelab/restic-backup/B2_ACCOUNT_ID')"
export B2_ACCOUNT_KEY="$(op read 'op://homelab/restic-backup/B2_ACCOUNT_KEY')"
export RESTIC_PASSWORD="$(op read 'op://homelab/restic-backup/RESTIC_PASSWORD')"
```

3. Restore via the restic container image — no local restic install, nothing written outside the scratch dir:

```sh
docker run --rm -it -v "$PWD/restore:/restore" -e RESTIC_REPOSITORY \
  -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -e RESTIC_PASSWORD restic/restic:0.18.0 \
  sh -c 'restic snapshots && restic restore --tag t3code latest --target /restore'
```

Run `restic snapshots` first and restore any snapshot by ID (or `latest --tag <tag>`) when you need a specific point in time.

4. Rebuild the cluster (sections 2–8). Re-applying `deploy/backup/base` reconnects to the same repository — `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` are unchanged, so existing snapshots stay readable and backups resume instead of starting over.

### Emergency fallback

`scripts/create-backup-secret.sh <bucket-name>` still works and creates the same Secret imperatively (into `agents`, next to the CronJob). Use it only when ESO or the vault is unavailable (e.g. a cold rebuild before the operator is installed): while ESO is healthy it reconciles `backup-target` back to the vault state within the refresh interval, so hand-made values do not stick. After using the fallback, copy the values into the `restic-backup` 1Password item and re-apply `deploy/backup/base` to hand control back to ESO.

## 12. Experimental: gVisor for sandbox pods

Runs loop-agent containers under gVisor's userspace kernel so kernel-level escapes from the privileged dind sidecar get much harder. **Untested on this cluster so far** — nested Docker inside gVisor is known to be rough. Verify the smoke test passes before relying on it.

Per node, install runsc and register it with k3s containerd:

```sh
curl -fsSL https://gvisor.dev/archive.key | \
  sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release/main" | \
  sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc

sudo mkdir -p /var/lib/rancher/k3s/agent/etc/containerd
printf '%s\n' \
  '{{ template "base" . }}' \
  '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]' \
  '  runtime_type = "io.containerd.runc.v2"' \
  '  runtime_engine = "/usr/local/bin/runsc"' \
  '  runtime_root = "/run/containerd/runsc"' | \
  sudo tee /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
sudo systemctl restart k3s
```

Then deploy the variant instead of the default:

```sh
kubectl apply -k deploy/gvisor/base     # replaces deploy/loop-agent/base
./scripts/new-job.sh gvisor-smoke 'node /data/repos/homelab/examples/loop-hello.mjs'
```
