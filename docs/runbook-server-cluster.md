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

Fine-grained PAT: https://github.com/settings/personal-access-tokens/new → Repository access: pick your repos → Permissions: Contents **Read-only**.

```sh
./scripts/create-github-secret.sh agents sandbox   # paste PAT when prompted
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

kubectl get pods -A -w    # watch it settle; ^C when Running
```

## 9. First contact

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
| Clone fails on private repo | PAT expired or missing repo access (Section 6) |

## 11. Nightly backups (off until you enable them)

PVC data (agent home dirs, hermes memory) can be backed up encrypted to object storage every night at 03:30. Git repos are skipped — they re-clone. Nothing runs until both steps below are done.

One-time setup:

```sh
./scripts/create-backup-secret.sh <bucket-name>   # prompts for B2 keys + repo password
kubectl apply -k deploy/backup/base
```

Save the restic password somewhere other than this cluster. Losing it means losing the backups.

Verify it ran: `kubectl logs job/restic-backup-<id> -n backup`. Restore from any machine with the same credentials and bucket access:

```sh
docker run --rm -it -v "$PWD:/restore" -e RESTIC_REPOSITORY=b2:<bucket>/homelab \
  -e B2_ACCOUNT_ID=... -e B2_ACCOUNT_KEY=... -e RESTIC_PASSWORD=... \
  restic/restic:0.18.0 restore latest --target /restore --include /mnt/t3code
```

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
