#!/bin/sh
# Installs the linters scripts/verify.sh runs into <bindir>, for CI on linux
# x86_64. Each sha256 is recorded here rather than fetched from the release,
# so a replaced release asset fails the install. Bump a version and its
# sha256 together. Elsewhere, install the same versions with a package manager.
#
# Usage: scripts/install-ci-tools.sh <bindir>
set -eu

# renovate: datasource=github-releases depName=koalaman/shellcheck extractVersion=^v(?<version>.+)$
SHELLCHECK_VERSION=0.11.0
SHELLCHECK_SHA256=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6
# renovate: datasource=github-releases depName=gitleaks/gitleaks extractVersion=^v(?<version>.+)$
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
# renovate: datasource=github-releases depName=rhysd/actionlint extractVersion=^v(?<version>.+)$
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
# renovate: datasource=github-releases depName=zizmorcore/zizmor extractVersion=^v(?<version>.+)$
ZIZMOR_VERSION=1.30.1
ZIZMOR_SHA256=e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a
# renovate: datasource=github-releases depName=hadolint/hadolint extractVersion=^v(?<version>.+)$
HADOLINT_VERSION=2.15.1
HADOLINT_SHA256=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507

bindir="${1:?usage: install-ci-tools.sh <bindir>}"
if [ "$(uname -s)/$(uname -m)" != "Linux/x86_64" ]; then
  echo "install-ci-tools: linux x86_64 only" >&2
  exit 1
fi
mkdir -p "$bindir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# fetch <url> <sha256> <file>: download into $tmp and verify.
fetch() {
  curl -fsSLo "$tmp/$3" "$1"
  echo "$2  $tmp/$3" | sha256sum -c --strict --quiet -
}

gh_dl=https://github.com

fetch "$gh_dl/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.gz" \
  "$SHELLCHECK_SHA256" shellcheck.tar.gz
tar -xzf "$tmp/shellcheck.tar.gz" -C "$tmp" "shellcheck-v${SHELLCHECK_VERSION}/shellcheck"
install -m 0755 "$tmp/shellcheck-v${SHELLCHECK_VERSION}/shellcheck" "$bindir/shellcheck"

fetch "$gh_dl/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  "$GITLEAKS_SHA256" gitleaks.tar.gz
tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$bindir/gitleaks"

fetch "$gh_dl/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
  "$ACTIONLINT_SHA256" actionlint.tar.gz
tar -xzf "$tmp/actionlint.tar.gz" -C "$tmp" actionlint
install -m 0755 "$tmp/actionlint" "$bindir/actionlint"

fetch "$gh_dl/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu.tar.gz" \
  "$ZIZMOR_SHA256" zizmor.tar.gz
tar -xzf "$tmp/zizmor.tar.gz" -C "$tmp" zizmor
install -m 0755 "$tmp/zizmor" "$bindir/zizmor"

fetch "$gh_dl/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64" \
  "$HADOLINT_SHA256" hadolint
install -m 0755 "$tmp/hadolint" "$bindir/hadolint"

"$bindir/shellcheck" --version | sed -n 2p
"$bindir/gitleaks" version
"$bindir/actionlint" --version | head -n 1
"$bindir/zizmor" --version
"$bindir/hadolint" --version
