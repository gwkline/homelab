#!/bin/sh
# Installs kubectl, sha256-verified against digests recorded here. Runs at
# image build time as root.
set -eu

# Bump the version and both digests together.
# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.+)$
KUBECTL_VERSION=1.37.1
KUBECTL_SHA256_AMD64=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
KUBECTL_SHA256_ARM64=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7

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
