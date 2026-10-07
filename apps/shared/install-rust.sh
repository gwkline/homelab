#!/bin/sh
# Installs a pinned Rust toolchain system-wide via a sha256-verified
# rustup-init. The caller sets RUSTUP_HOME/CARGO_HOME (ENV) and puts
# $CARGO_HOME/bin on PATH. Both trees are left writable so the runtime uid
# can fetch crates and install a toolchain a repo's rust-toolchain.toml asks
# for. Needs a C linker (gcc or g++) from the caller's apt layer.
set -eu

: "${RUSTUP_HOME:?RUSTUP_HOME must be set}" "${CARGO_HOME:?CARGO_HOME must be set}"

# renovate: datasource=github-tags depName=rust-lang/rust
RUST_VERSION=1.98.0
# renovate: datasource=github-tags depName=rust-lang/rustup
RUSTUP_VERSION=1.29.1

case "$(uname -m)" in
  x86_64) target=x86_64-unknown-linux-gnu ;;
  aarch64) target=aarch64-unknown-linux-gnu ;;
  *) echo "install-rust: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

url="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${target}/rustup-init"
curl -fsSLo /tmp/rustup-init "${url}"
sum="$(curl -fsSL "${url}.sha256")"
echo "${sum%% *}  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}"
rm -f /tmp/rustup-init
chmod -R a+rwX "${RUSTUP_HOME}" "${CARGO_HOME}"
cargo --version
