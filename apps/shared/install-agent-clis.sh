#!/bin/sh
# Installs the coding-agent CLIs shared by apps/t3code and apps/factory/worker,
# each at an exact version, so two builds of one commit install the same
# CLIs. The model APIs reject clients that fall too far behind, so Renovate
# bumps the npm pins weekly ("agent CLIs" group in renovate.json).
# The --version checks fail the build if npm skipped a platform binary.
set -eu

# renovate: datasource=npm depName=@openai/codex
CODEX_VERSION=0.169.0
# renovate: datasource=npm depName=@anthropic-ai/claude-code
CLAUDE_CODE_VERSION=2.1.325
# renovate: datasource=npm depName=opencode-ai
OPENCODE_VERSION=1.19.5
# Cursor publishes no checksum file: the per-arch digests were recorded with
# the pin. Bump all three together.
# renovate: datasource=custom.cursor-agent depName=cursor-agent extractVersion=^DOWNLOAD_URL="https://downloads\.cursor\.com/lab/(?<version>[^/]+)/
CURSOR_AGENT_VERSION=2026.11.13-eacade1
CURSOR_AGENT_SHA256_X64=c02e4321f20d691ee03af94d29948dc3a81c6c34e7328da7bb1afade4c75812f
CURSOR_AGENT_SHA256_ARM64=e4ba0611045a24d1cf78f021d34c19461680fc7234c19c1f981f1cc169f70cdc

npm install -g \
  "@openai/codex@${CODEX_VERSION}" \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
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
