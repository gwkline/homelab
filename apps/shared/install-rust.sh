#!/bin/sh
# Installs a pinned Rust toolchain system-wide via rustup-init, sha256-verified
# against digests recorded here; rustup verifies the toolchain it downloads.
# The caller sets RUSTUP_HOME/CARGO_HOME (ENV) and puts $CARGO_HOME/bin on
# PATH. Both trees are left writable so the runtime uid can fetch crates and
# install a toolchain a repo's rust-toolchain.toml asks for. Needs a C linker
# (gcc or g++) from the caller's apt layer.
set -eu

: "${RUSTUP_HOME:?RUSTUP_HOME must be set}" "${CARGO_HOME:?CARGO_HOME must be set}"

# renovate: datasource=github-tags depName=rust-lang/rust
RUST_VERSION=1.98.0
# Bump the version and both digests together.
# renovate: datasource=github-tags depName=rust-lang/rustup
RUSTUP_VERSION=1.29.1
RUSTUP_SHA256_X86_64=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
RUSTUP_SHA256_AARCH64=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433

case "$(uname -m)" in
  x86_64) target=x86_64-unknown-linux-gnu; sha="${RUSTUP_SHA256_X86_64}" ;;
  aarch64) target=aarch64-unknown-linux-gnu; sha="${RUSTUP_SHA256_AARCH64}" ;;
  *) echo "install-rust: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${target}/rustup-init"
echo "${sha}  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}"
rm -f /tmp/rustup-init
chmod -R a+rwX "${RUSTUP_HOME}" "${CARGO_HOME}"
cargo --version
