#!/usr/bin/env bash
# Bootstrap a fresh Ubuntu Server 24.04 box into the homelab cluster.
# Usage:
#   bootstrap.sh server            # control-plane (first node only)
#   bootstrap.sh agent <server-ip> # join an existing cluster
set -euo pipefail

ROLE="${1:?usage: bootstrap.sh server|agent [server-ip]}"
case "$ROLE" in
  server|agent) ;;
  *) echo "unknown role: $ROLE (want server or agent)" >&2; exit 1 ;;
esac
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Pinned so a rebuild installs exactly what was tested. Override only for a
# deliberate upgrade; version and installer sha256 change together.
K3S_VERSION="${K3S_VERSION:-v1.36.4+k3s1}"
TAILSCALE_VERSION="${TAILSCALE_VERSION:-1.102.4}"
K3S_INSTALLER_SHA256="${K3S_INSTALLER_SHA256:-46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad}"
TAILSCALE_INSTALLER_SHA256="${TAILSCALE_INSTALLER_SHA256:-805e85ed6f6f81a7ea2e70d52d47e7d5290863299e5c922b2787d71aa312f22e}"

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

# The Ubuntu installer provisions the root LV at roughly half the disk; grow it
# to the full VG before anything lands on it. Skipped when nothing is free.
VFREE_KB="$(sudo vgs --noheadings --units k -o vg_free 2>/dev/null | tr -dc 0-9 || echo 0)"
if [ "${VFREE_KB:-0}" -gt 1048576 ]; then
  echo "==> growing root LV into ${VFREE_KB} KiB of free VG space"
  sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
  sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
else
  echo "==> root LV: no meaningful VG free space (${VFREE_KB} KiB); skipping growth"
fi

echo "==> installing tailscale ${TAILSCALE_VERSION}"
fetch_verified \
  "https://raw.githubusercontent.com/tailscale/tailscale/v${TAILSCALE_VERSION}/scripts/installer.sh" \
  "$TAILSCALE_INSTALLER_SHA256" \
  "$TMP_DIR/tailscale-install.sh"
TAILSCALE_VERSION="$TAILSCALE_VERSION" sh "$TMP_DIR/tailscale-install.sh"
sudo tailscale up --ssh

echo "==> disabling sleep (agent host must stay awake)"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# Alloy follows every container's log through the kubelet, and each follow
# holds an inotify instance; at Ubuntu's default of 128 the follows fail and
# Loki loses those logs.
echo "==> raising inotify limits"
printf '%s\n' 'fs.inotify.max_user_instances = 8192' 'fs.inotify.max_user_watches = 524288' |
  sudo tee /etc/sysctl.d/90-inotify.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/90-inotify.conf

# All k3s settings live in the repo file; the installer gets no flags, so a
# re-run (also an upgrade) converges the node to it. k3s reads the file on
# start, and the installer restarts the service.
echo "==> installing /etc/rancher/k3s/config.yaml"
sudo install -D -m 0600 -o root -g root "$REPO_DIR/bootstrap/k3s-config.yaml" /etc/rancher/k3s/config.yaml

if [[ "$ROLE" == "server" ]]; then
  echo "==> installing k3s ${K3S_VERSION} (control-plane)"
  fetch_verified \
    "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION}/install.sh" \
    "$K3S_INSTALLER_SHA256" \
    "$TMP_DIR/k3s-install.sh"
  # kubeconfig stays root-only (600); fetch it from your laptop with:
  #   ssh <user>@<node-ip> sudo cat /etc/rancher/k3s/k3s.yaml
  INSTALL_K3S_VERSION="$K3S_VERSION" sh "$TMP_DIR/k3s-install.sh" server
  echo "==> kubeconfig: /etc/rancher/k3s/k3s.yaml"
  echo "==> node token: /var/lib/rancher/k3s/server/node-token"
else
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
fi

echo "==> done. verify with: kubectl get nodes"
