# Factory coding worker (#74): ephemeral, unattended, no server.
# Reuses t3code's tested CLI-install layers; runtime state stays in-task.
# Differences vs t3code: no t3 serve, no pairing, no persistent volumes,
# explicit /task (input) and /out (output) contract dirs.

FROM node:24-bookworm-slim

ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ curl unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# gh CLI (#23): consistent CLI for issues/branches/PRs/CI checks.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Pinned Rust toolchain (matches t3code image so builds behave identically).
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y \
      --profile minimal --default-toolchain "${RUST_VERSION}" \
  && chmod -R a+rwX /usr/local/rustup /usr/local/cargo

# Coding CLIs — same pins as apps/t3code/Dockerfile (keep in sync).
RUN npm install -g \
      @openai/codex@latest \
      @anthropic-ai/claude-code@latest \
      opencode-ai@1.18.23

# Cursor CLI — pinned lab release, exact mechanism from apps/t3code/Dockerfile.
ARG CURSOR_AGENT_VERSION=2026.08.11-e8db854
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in x86_64|amd64) CARCH=x64 ;; arm64|aarch64) CARCH=arm64 ;; esac \
  && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${CARCH}/agent-cli-package.tar.gz" \
      -o /tmp/cursor-agent.tar.gz \
  && mkdir -p /opt/cursor-agent \
  && tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent \
  && ln -s /opt/cursor-agent/dist-package/cursor-agent /usr/local/bin/cursor-agent \
  && rm /tmp/cursor-agent.tar.gz

# Non-root worker; task I/O on explicit volume-style paths.
# node:24 base already ships a non-root 'node' user (uid 1000) — reuse it.
RUN mkdir -p /task /out /work && chown -R node:node /task /out /work
USER node
WORKDIR /work

COPY apps/factory/worker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

ENTRYPOINT ["/usr/local/bin/entrypoint"]
