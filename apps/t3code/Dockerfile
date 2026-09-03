FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# python3/make/g++ exist for node-pty (native dep of t3) when no prebuild
# matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ curl unzip \
  && rm -rf /var/lib/apt/lists/*

# Rust toolchain so cargo repos (e.g. launchpad) build out of the box.
# System-wide install under /usr/local: uid 1000 gets it at runtime with no
# per-user rustup. pkg-config/libssl-dev cover the common openssl-sys dep.
# (The sh.rustup.rs bootstrap itself is not checksum-pinnable — static.rust-
# lang.org serves rustup-init without a version-stable URL scheme — but the
# toolchain it installs is pinned below, which is what code actually builds
# against.)
ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
RUN curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" --no-modify-path \
  && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}" \
  && cargo --version

# Coding CLIs. Every version is a recorded resolution (issue #35): nightly
# and beta channels are pinned to the exact version the dist-tag pointed at
# when this image last changed, and Renovate (renovate.json) proposes bumps
# within the same channel — so the bleeding edge still flows, but only
# through a reviewed diff. A rebuild from this commit installs exactly these.
# renovate: datasource=npm depName=t3
ARG T3_VERSION=0.0.39-nightly.20260902.1260
# renovate: datasource=npm depName=@openai/codex
ARG CODEX_VERSION=0.152.1
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.258
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_VERSION=1.18.23
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_BETA_VERSION=0.0.0-beta-202608110357
RUN npm install -g \
      "t3@${T3_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
  && npm install -g --prefix /opt/opencode-v2 "opencode-ai@${OPENCODE_BETA_VERSION}" \
  && ln -sf /opt/opencode-v2/bin/opencode /usr/local/bin/opencode-beta \
  && opencode-beta --version

# Cursor CLI — pinned lab release. Cursor publishes no checksum file, so the
# SHA-256 of the exact tarball (per arch) was recorded when the pin was set
# and is verified at build time; bump the version and both digests together.
# The installer script (https://cursor.com/install) is just a wrapper around
# this tarball URL; we call it directly so builds are deterministic and work
# from datacenter IPs (the installer's own redirect chain sometimes doesn't).
ARG CURSOR_AGENT_VERSION=2026.08.11-e8db854
ARG CURSOR_AGENT_SHA256_X64=bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a
ARG CURSOR_AGENT_SHA256_ARM64=ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in \
       x86_64|amd64) CARCH=x64; SHA="${CURSOR_AGENT_SHA256_X64}" ;; \
       arm64|aarch64) CARCH=arm64; SHA="${CURSOR_AGENT_SHA256_ARM64}" ;; \
     esac \
  && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${CARCH}/agent-cli-package.tar.gz" \
      -o /tmp/cursor-agent.tar.gz \
  && echo "${SHA}  /tmp/cursor-agent.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/cursor-agent \
  && tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent \
  && ln -s /opt/cursor-agent/dist-package/cursor-agent /usr/local/bin/cursor-agent \
  && rm /tmp/cursor-agent.tar.gz

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace

ENV DATA_DIR=/data
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
