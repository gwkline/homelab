#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu Server 24.04 box into the homelab cluster.
# Usage:
#   bootstrap.sh server            # control-plane (first node only)
#   bootstrap.sh agent <server-ip> # join an existing cluster
set -euo pipefail

ROLE="${1:?usage: bootstrap.sh server|agent [server-ip]}"

if [[ $EUID -eq 0 ]]; then
  echo "run as a normal user with sudo access, not root" >&2
  exit 1
fi

echo "==> installing prerequisites"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates git

echo "==> installing tailscale"
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh

echo "==> disabling sleep (agent host must stay awake)"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

if [[ "$ROLE" == "server" ]]; then
  echo "==> installing k3s (control-plane)"
  # kubeconfig stays root-only (600); fetch it from your laptop with:
  #   ssh <user>@<node-ip> sudo cat /etc/rancher/k3s/k3s.yaml
  curl -sfL https://get.k3s.io | sh -s - server \
    --disable traefik
  echo "==> kubeconfig: /etc/rancher/k3s/k3s.yaml"
  echo "==> node token: /var/lib/rancher/k3s/server/node-token"
elif [[ "$ROLE" == "agent" ]]; then
  SERVER_IP="${2:?usage: bootstrap.sh agent <server-ip>}"
  read -rsp "node token (from server: /var/lib/rancher/k3s/server/node-token): " TOKEN
  echo
  echo "==> joining cluster at ${SERVER_IP}"
  curl -sfL https://get.k3s.io | \
    K3S_URL="https://${SERVER_IP}:6443" K3S_TOKEN="$TOKEN" \
    sh -s - agent
else
  echo "unknown role: $ROLE" >&2
  exit 1
fi

echo "==> done. verify with: kubectl get nodes"
