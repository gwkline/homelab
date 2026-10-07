# Server cluster runbook — first-time hardware, OS, and k3s

From bare machines to Ready k3s nodes, plus the one-time external accounts. One machine runs the k3s **server**; any others join as **agent** nodes. Deploying the cluster itself is [rebuild-runbook.md](rebuild-runbook.md).

| Placeholder     | Meaning                            |
| --------------- | ---------------------------------- |
| `<user>`        | your username on the servers       |
| `<server-ip>`   | LAN IP of the k3s server           |
| `<agent-ip>`    | LAN IP of an agent node (optional) |
| `<github-user>` | GitHub owner of this repo          |

## 0. Prerequisites

- 1+ x86_64 (or arm64) machines, 8 GB+ RAM, a spare 16 GB+ disk each; Ethernet preferred
- A 4 GB+ USB stick, and a laptop to drive everything from

## 1. BIOS (per machine, monitor attached)

- **Restore on AC Power Loss → Power On**, so machines return after an outage
- **Boot mode → UEFI** (CSM/Legacy off)
- **Secure Boot off** (avoids driver/MOK friction)

## 2. Ubuntu Server 24.04 LTS (per machine)

1. Flash `ubuntu-24.04.x-live-server-amd64.iso` with [balenaEtcher](https://etcher.balena.io/) or `dd`.
2. Installer: Ubuntu Server (no extras), DHCP, **use entire disk** (no LVM), user `<user>`, hostname `agent-1`, `agent-2`, …, **[x] Install OpenSSH server**, no snaps.
3. Reboot, note the IP from the summary screen or your router.

Headless physical hosts also need `nomodeset`, or a reboot without a monitor can hang:

```sh
sudo sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="quiet splash nomodeset"/' /etc/default/grub
sudo update-grub
sudo grep -c nomodeset /boot/grub/grub.cfg   # must be >= 1
```

## 3. Bootstrap k3s + Tailscale

`bootstrap/bootstrap.sh` installs pinned, sha256-verified Tailscale (with Tailscale SSH) and k3s. It requires Ubuntu 24.04 on amd64/arm64 and a non-root sudo user.

Server (first machine only):

```sh
ssh <user>@<server-ip>
sudo apt-get install -y git
git clone https://github.com/<github-user>/homelab.git && cd homelab
./bootstrap/bootstrap.sh server
```

Each agent node (optional), with the token from `ssh <user>@<server-ip> sudo cat /var/lib/rancher/k3s/server/node-token`:

```sh
ssh <user>@<agent-ip>
sudo apt-get install -y git
git clone https://github.com/<github-user>/homelab.git && cd homelab
./bootstrap/bootstrap.sh agent <server-ip>   # prompts for the node token
```

`sudo k3s kubectl get nodes` on the server shows every node Ready within ~60 s.

## 4. kubectl from the laptop

```sh
brew install kubectl helm                                   # or see kubernetes.io/docs/tasks/tools
ssh <user>@<server-ip> sudo cat /etc/rancher/k3s/k3s.yaml > ~/kubeconfig-homelab
sed -i '' "s|127.0.0.1|<server-ip>|" ~/kubeconfig-homelab   # GNU sed: drop the ''
export KUBECONFIG=~/kubeconfig-homelab
kubectl get nodes
```

## 5. One-time external accounts

| What | Do once | Contract |
| --- | --- | --- |
| 1Password | Vault `homelab`; a service account that can read only that vault (its `ops_…` token is shown once) | [secrets-inventory.md](secrets-inventory.md) |
| Tailscale | MagicDNS + HTTPS certs on; `tagOwners` owns `tag:k8s-operator`; OAuth client created **with** that tag (Devices/Core + Auth Keys write, Routes read), stored as item `tailscale-operator-oauth` | [deploy/tailscale/README.md](../deploy/tailscale/README.md) |
| GitHub | Fine-grained PAT, Contents read-only → item `github-readonly`; optional writer PAT → `github-writer` | [deploy/github-tokens/README.md](../deploy/github-tokens/README.md) |
| GHCR | After CI's first push, make each `ghcr.io/<github-user>/homelab/*` package public (Packages → Package settings → visibility), or create `ghcr-pull` Secrets | `ImagePullBackOff` means this step was skipped |

Then follow [rebuild-runbook.md](rebuild-runbook.md) from step 2.

## Upgrading pinned k3s / Tailscale

Deliberate, never automatic. Version and installer sha256 always change together.

1. Hash the installers at the new immutable tags:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/k3s-io/k3s/<new-tag>/install.sh | sha256sum
   curl -fsSL https://raw.githubusercontent.com/tailscale/tailscale/v<new>/scripts/installer.sh | sha256sum
   ```

2. Update `K3S_VERSION` + `K3S_INSTALLER_SHA256` and/or `TAILSCALE_VERSION` + `TAILSCALE_INSTALLER_SHA256` in `bootstrap/bootstrap.sh` (env overrides allow upgrading a node before the repo change lands).
3. Re-run `./bootstrap/bootstrap.sh server` (upgrade-aware), then each agent; check `k3s --version` and `tailscale version`.
4. Run `./scripts/rebuild-check.sh`.

## When a node dies

- **Agent node:** reinstall Ubuntu (step 2), then `./bootstrap/bootstrap.sh agent <server-ip>` with the same token.
- **Server:** reinstall, bootstrap as server, then [rebuild-runbook.md](rebuild-runbook.md).

PVC data on the dead node is gone (local-path). Repos re-clone; unpushed agent work is lost.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ImagePullBackOff` on homelab images | GHCR visibility (step 5) |
| Node NotReady after reboot | `sudo systemctl status k3s` (server) / `k3s-agent` (agent) on that node |
| Headless reboot hangs | `nomodeset` (step 2) |
| Job logs gone after TTL | query Loki: `{job_name="<job>"}` ([deploy/loki/README.md](../deploy/loki/README.md)) |
| Private repo clone fails | 1Password `github-readonly` expired or missing repo access |
