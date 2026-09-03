#!/bin/sh
# Shared gh CLI installer for the coding-agent images (#23). One strategy
# across t3code, hermes, and loop-agent so the pin and its verification
# cannot drift between Dockerfiles: downloads the exact release tarball
# named by GH_VERSION, verifies it against the checksums.txt file published
# alongside that release, and installs the binary to /usr/local/bin.
# Runs at image build time as root. Carries no credentials: gh
# authentication is runtime-only (GH_TOKEN/GITHUB_TOKEN pod env or a
# mounted token file read by the entrypoints) — never baked into a layer.
# Callers (Dockerfiles) declare the pin so Renovate bumps it:
#   # renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
#   ARG GH_VERSION=x.y.z
# Requires curl + tar + (ideally) dpkg from the caller's earlier layers.
set -eu

: "${GH_VERSION:?GH_VERSION must be set (renovate-pinned ARG in the calling Dockerfile)}"

# amd64 and arm64 are both covered; the bases build on amd64 today, but the
# installer follows whatever platform the base provides.
case "$(uname -m)" in
  x86_64) gh_arch="amd64" ;;
  aarch64) gh_arch="arm64" ;;
  *) gh_arch="$(dpkg --print-architecture 2>/dev/null || true)" ;;
esac
if [ -z "${gh_arch}" ]; then
  echo "install-gh: unsupported architecture ($(uname -m))" >&2
  exit 1
fi

gh_tarball="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"
gh_url="https://github.com/cli/cli/releases/download/v${GH_VERSION}"
curl -fsSLo "/tmp/${gh_tarball}" "${gh_url}/${gh_tarball}"
(cd /tmp \
  && curl -fsSL "${gh_url}/gh_${GH_VERSION}_checksums.txt" \
      | grep "${gh_tarball}" | sha256sum -c -)
tar -xzf "/tmp/${gh_tarball}" -C /tmp
install -m755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh
rm -rf "/tmp/${gh_tarball}" \
  "/tmp/gh_${GH_VERSION}_linux_${gh_arch}" \
  "/tmp/gh_${GH_VERSION}_checksums.txt"
gh --version
