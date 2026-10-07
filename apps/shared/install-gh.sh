#!/bin/sh
# Installs the gh CLI, sha256-verified against the release's checksums.txt.
# Runs at image build time as root. The image carries no credentials: gh
# reads GH_TOKEN/GITHUB_TOKEN from the pod at runtime.
set -eu

# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
GH_VERSION=2.98.0

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "install-gh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

name="gh_${GH_VERSION}_linux_${arch}"
url="https://github.com/cli/cli/releases/download/v${GH_VERSION}"
curl -fsSLo "/tmp/${name}.tar.gz" "${url}/${name}.tar.gz"
sums="$(curl -fsSL "${url}/gh_${GH_VERSION}_checksums.txt")"
(cd /tmp && printf '%s\n' "${sums}" | grep -F "${name}.tar.gz" | sha256sum -c -)
tar -xzf "/tmp/${name}.tar.gz" -C /tmp
install -m 0755 "/tmp/${name}/bin/gh" /usr/local/bin/gh
rm -rf "/tmp/${name}.tar.gz" "/tmp/${name}"
gh --version
