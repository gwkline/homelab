FROM node:24-bookworm-slim

# python3/make/g++ exist for node-pty (native dep of t3) when no prebuild
# matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g t3@0.0.33

# Bleeding-edge matrix (Gavin wants nightlies where available):
#  - t3code: nightly channel
#  - codex: latest stable (npm has no nightly tag)
#  - claude-code: latest stable (npm latest == newest release)
#  - opencode v1: latest stable, kept until t3code supports v2
#  - opencode v2 beta: separate npm prefix, exposed as `opencode-beta`
RUN npm install -g \
      t3@nightly \
      @openai/codex@latest \
      @anthropic-ai/claude-code@latest \
      opencode-ai@1.18.23 \
  && npm install -g --prefix /opt/opencode-v2 opencode-ai@beta \
  && ln -sf /opt/opencode-v2/bin/opencode /usr/local/bin/opencode-beta \
  && opencode-beta --version

# Cursor CLI — pinned to the same version the official installer fetches.
# The installer script (https://cursor.com/install) is just a wrapper around
# this tarball URL; we call it directly so builds are deterministic and work
# from datacenter IPs (the installer's own redirect chain sometimes doesn't).
# Bump CURSOR_AGENT_VERSION when Cursor ships a new lab release.
ARG CURSOR_AGENT_VERSION=2026.08.11-e8db854
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in x86_64|amd64) CARCH=x64 ;; arm64|aarch64) CARCH=arm64 ;; esac \
  && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${CARCH}/agent-cli-package.tar.gz" \
      -o /tmp/cursor-agent.tar.gz \
  && mkdir -p /opt/cursor-agent \
  && tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent \
  && ln -s /opt/cursor-agent/dist-package/cursor-agent /usr/local/bin/cursor-agent \
  && rm /tmp/cursor-agent.tar.gz

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace

ENV DATA_DIR=/data
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
