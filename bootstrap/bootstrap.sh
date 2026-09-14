#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu Server 24.04 box into the homelab cluster.
# Usage:
#   bootstrap.sh server            # control-plane (first node only)
#   bootstrap.sh agent <server-ip> # join an existing cluster
set -euo pipefail

ROLE="${1:?usage: bootstrap.sh server|agent [server-ip]}"

# Pinned for reproducible recovery (issue #29): a rebuild must install exactly
# the versions the manifests and workarounds were tested against. Override only
# for a deliberate upgrade — version and installer sha256 change together, and
# the cluster smoke tests in docs/rebuild-runbook.md §2a run afterwards.
K3S_VERSION="${K3S_VERSION:-v1.36.4+k3s1}"
TAILSCALE_VERSION="${TAILSCALE_VERSION:-1.102.4}"
# sha256 of each installer at its immutable version tag; a mismatch refuses to
# execute instead of piping unverified remote content into a root shell.
K3S_INSTALLER_SHA256="${K3S_INSTALLER_SHA256:-46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad}"
TAILSCALE_INSTALLER_SHA256="${TAILSCALE_INSTALLER_SHA256:-805e85ed6f6f81a7ea2e70d52d47e7d5290863299e5c922b2787d71aa312f22e}"

# Platform contract: Ubuntu Server 24.04 on amd64 or arm64 — the only
# combinations both k3s and Tailscale publish and the drill has covered.
if [[ $EUID -eq 0 ]]; then
  echo "run as a normal user with sudo access, not root" >&2
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  echo "unsupported OS: bootstrap targets Ubuntu 24.04 (found ${ID:-unknown} ${VERSION_ID:-unknown})" >&2
  exit 1
fi
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "unsupported architecture: $ARCH (need amd64 or arm64)" >&2; exit 1 ;;
esac

# Download an installer from its immutable version tag and verify its content
# against the pinned sha256 before running it.
fetch_verified() {
  local url="$1" want="$2" dest="$3"
  echo "==> fetching installer: $url"
  curl -fsSL "$url" -o "$dest"
  printf '%s  %s\n' "$want" "$dest" | sha256sum -c --status || {
    echo "refusing to run installer: sha256 mismatch for $url (expected $want)" >&2
    exit 1
  }
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> installing prerequisites"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates git

echo "==> installing tailscale ${TAILSCALE_VERSION}"
fetch_verified \
  "https://raw.githubusercontent.com/tailscale/tailscale/v${TAILSCALE_VERSION}/scripts/installer.sh" \
  "$TAILSCALE_INSTALLER_SHA256" \
  "$TMP_DIR/tailscale-install.sh"
TAILSCALE_VERSION="$TAILSCALE_VERSION" sh "$TMP_DIR/tailscale-install.sh"
sudo tailscale up --ssh

echo "==> disabling sleep (agent host must stay awake)"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

if [[ "$ROLE" == "server" ]]; then
  echo "==> installing k3s ${K3S_VERSION} (control-plane)"
  fetch_verified \
    "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION}/install.sh" \
    "$K3S_INSTALLER_SHA256" \
    "$TMP_DIR/k3s-install.sh"
  # kubeconfig stays root-only (600); fetch it from your laptop with:
  #   ssh <user>@<node-ip> sudo cat /etc/rancher/k3s/k3s.yaml
  INSTALL_K3S_VERSION="$K3S_VERSION" sh "$TMP_DIR/k3s-install.sh" server \
    --disable traefik
  echo "==> kubeconfig: /etc/rancher/k3s/k3s.yaml"
  echo "==> node token: /var/lib/rancher/k3s/server/node-token"
elif [[ "$ROLE" == "agent" ]]; then
  SERVER_IP="${2:?usage: bootstrap.sh agent <server-ip>}"
  read -rsp "node token (from server: /var/lib/rancher/k3s/server/node-token): " TOKEN
  echo
  fetch_verified \
    "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION}/install.sh" \
    "$K3S_INSTALLER_SHA256" \
    "$TMP_DIR/k3s-install.sh"
  echo "==> joining cluster at ${SERVER_IP}"
  K3S_URL="https://${SERVER_IP}:6443" K3S_TOKEN="$TOKEN" \
    INSTALL_K3S_VERSION="$K3S_VERSION" sh "$TMP_DIR/k3s-install.sh" agent
else
  echo "unknown role: $ROLE" >&2
  exit 1
fi

echo "==> done. verify with: kubectl get nodes"
