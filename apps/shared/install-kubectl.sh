#!/bin/sh
# Installs kubectl, sha256-verified against the checksum dl.k8s.io publishes
# for the exact binary. Runs at image build time as root.
set -eu

# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.+)$
KUBECTL_VERSION=1.37.1

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "install-kubectl: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

url="https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"
curl -fsSLo /tmp/kubectl "${url}"
sum="$(curl -fsSL "${url}.sha256")"
echo "${sum}  /tmp/kubectl" | sha256sum -c -
install -m 0755 /tmp/kubectl /usr/local/bin/kubectl
rm -f /tmp/kubectl
kubectl version --client
