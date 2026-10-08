#!/bin/sh
# Installs the gh CLI, sha256-verified against digests recorded here. Runs at
# image build time as root. The image carries no credentials: gh reads
# GH_TOKEN/GITHUB_TOKEN from the pod at runtime.
set -eu

# Bump the version and both digests together.
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
GH_VERSION=2.98.0
GH_SHA256_AMD64=3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de
GH_SHA256_ARM64=cf689084f3a3618f7eae4a2420d335d74626d65f5e594b9828d125d69f800d86

case "$(uname -m)" in
  x86_64) arch=amd64; sha="${GH_SHA256_AMD64}" ;;
  aarch64) arch=arm64; sha="${GH_SHA256_ARM64}" ;;
  *) echo "install-gh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

name="gh_${GH_VERSION}_linux_${arch}"
curl -fsSLo "/tmp/${name}.tar.gz" "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${name}.tar.gz"
echo "${sha}  /tmp/${name}.tar.gz" | sha256sum -c -
tar -xzf "/tmp/${name}.tar.gz" -C /tmp
install -m 0755 "/tmp/${name}/bin/gh" /usr/local/bin/gh
rm -rf "/tmp/${name}.tar.gz" "/tmp/${name}"
gh --version
