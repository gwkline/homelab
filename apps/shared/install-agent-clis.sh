#!/bin/sh
# Installs the coding-agent CLIs shared by apps/t3code and apps/factory/worker.
# codex and claude-code float on their latest dist-tags: the model APIs reject
# clients that fall behind, so a recorded pin turns into an outage. Callers
# declare ARG CACHEBUST before this layer so every CI build re-resolves them.
# The --version checks fail the build if npm skipped a platform binary.
set -eu

# renovate: datasource=npm depName=opencode-ai
OPENCODE_VERSION=1.18.23
# Cursor publishes no checksum file: the per-arch digests were recorded with
# the pin. Bump all three together.
CURSOR_AGENT_VERSION=2026.08.11-e8db854
CURSOR_AGENT_SHA256_X64=bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a
CURSOR_AGENT_SHA256_ARM64=ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed

npm install -g \
  "@openai/codex@latest" \
  "@anthropic-ai/claude-code@latest" \
  "opencode-ai@${OPENCODE_VERSION}"

case "$(uname -m)" in
  x86_64) arch=x64; sha="${CURSOR_AGENT_SHA256_X64}" ;;
  aarch64) arch=arm64; sha="${CURSOR_AGENT_SHA256_ARM64}" ;;
  *) echo "install-agent-clis: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSLo /tmp/cursor-agent.tar.gz \
  "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${arch}/agent-cli-package.tar.gz"
echo "${sha}  /tmp/cursor-agent.tar.gz" | sha256sum -c -
mkdir -p /opt/cursor-agent
tar -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent
ln -sf /opt/cursor-agent/dist-package/cursor-agent /usr/local/bin/cursor-agent
rm -f /tmp/cursor-agent.tar.gz

codex --version
claude --version
opencode --version
cursor-agent --version
