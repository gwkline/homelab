#!/bin/sh
# Installs kubectl, sha256-verified against digests recorded here. Runs at
# image build time as root.
set -eu

# Bump the version and both digests together.
# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.+)$
KUBECTL_VERSION=1.37.2
KUBECTL_SHA256_AMD64=c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4
KUBECTL_SHA256_ARM64=fcc16f63186659d9722014b7e02d5fdd2d4e669cb8c0ab66365d7d3b8ba03509

case "$(uname -m)" in
  x86_64) arch=amd64; sha="${KUBECTL_SHA256_AMD64}" ;;
  aarch64) arch=arm64; sha="${KUBECTL_SHA256_ARM64}" ;;
  *) echo "install-kubectl: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"
echo "${sha}  /tmp/kubectl" | sha256sum -c -
install -m 0755 /tmp/kubectl /usr/local/bin/kubectl
rm -f /tmp/kubectl
kubectl version --client
