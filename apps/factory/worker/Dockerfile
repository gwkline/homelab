# Factory coding worker (#74): ephemeral, unattended, no server.
# Reuses t3code's tested CLI-install layers; runtime state stays in-task.
# Differences vs t3code: no t3 serve, no pairing, no persistent volumes,
# explicit /task (input) and /out (output) contract dirs.

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ curl unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# gh CLI (#23): consistent CLI for issues/branches/PRs/CI checks — exact
# release, verified against the checksums.txt published with it (#35).
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
ARG GH_VERSION=2.98.0
RUN curl -fsSLo "/tmp/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
          | grep "gh_${GH_VERSION}_linux_amd64.tar.gz" | sha256sum -c -) \
  && tar -xzf "/tmp/gh_${GH_VERSION}_linux_amd64.tar.gz" -C /tmp --strip-components=1 \
  && install -m755 /tmp/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp/* \
  && gh --version

# Pinned Rust toolchain (matches t3code image so builds behave identically).
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y \
      --profile minimal --default-toolchain "${RUST_VERSION}" \
  && chmod -R a+rwX /usr/local/rustup /usr/local/cargo

# Coding CLIs — same recorded pins as apps/t3code/Dockerfile (keep in sync,
# issue #35): exact versions, Renovate proposes bumps through reviewed PRs.
# renovate: datasource=npm depName=@openai/codex
ARG CODEX_VERSION=0.152.1
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.258
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_VERSION=1.18.23
RUN npm install -g \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}"

# Cursor CLI — pinned lab release; SHA-256 of the exact tarball (per arch)
# recorded at pin time and verified here (no upstream checksum file exists).
# Same mechanism as apps/t3code/Dockerfile; bump version + digests together.
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

# Non-root worker; task I/O on explicit volume-style paths.
# node:24 base already ships a non-root 'node' user (uid 1000) — reuse it.
RUN mkdir -p /task /out /work && chown -R node:node /task /out /work
USER node
WORKDIR /work

COPY --chmod=755 --chown=node:node apps/factory/worker/entrypoint.sh /usr/local/bin/entrypoint


ENTRYPOINT ["/usr/local/bin/entrypoint"]
