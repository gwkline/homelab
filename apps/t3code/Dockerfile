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

# Coding CLIs (t3, codex, claude-code) float on their npm dist-tags
# (operator direction 2026-10-05): NO version is recorded in this repo —
# every image build resolves whatever the channel currently serves, and
# ci.yaml additionally rebuilds weekly. The previous exact-pin + Renovate
# flow kept serving stale CLIs (server-side claude 2.1.258 vs client
# 2.1.289 made model calls fail with "version X or newer is required"),
# and the nightly pins rotted for a month between bumps. opencode stays
# pinned: Renovate still proposes reviewed bumps for it.
#
# CACHEBUST defeats the GHA layer cache for the resolution layer: with a
# floating dist-tag, a cached npm-install layer would silently keep the
# versions some earlier build resolved. CI passes
# --build-arg CACHEBUST=<run id> on every build so resolution always
# re-runs; the default keeps plain `docker build` working.
ARG CACHEBUST=1
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_VERSION=1.18.23
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_BETA_VERSION=0.0.0-beta-202608110357
RUN CACHEBUST="${CACHEBUST}" npm install -g \
      t3@nightly \
      "@openai/codex@latest" \
      "@anthropic-ai/claude-code@latest" \
      "opencode-ai@${OPENCODE_VERSION}" \
  && npm install -g --prefix /opt/opencode-v2 "opencode-ai@${OPENCODE_BETA_VERSION}" \
  && ln -sf /opt/opencode-v2/bin/opencode /usr/local/bin/opencode-beta \
  && opencode-beta --version \
  && t3 --version \
  && codex --version \
  && claude --version
# The three --version checks above are load-bearing, not cosmetic: the
# t3 binary ships as an npm OPTIONAL dependency that lags the main
# package by minutes during a nightly publish — npm silently skips a
# 404ing optional dep, and the wrapper alone crash-loops the whole
# pod at boot ("no T3 Code CLI build is available for this platform").
# A build in that window must fail HERE, in CI, not on the cluster.

# gh CLI — installed by the shared installer (apps/shared/install-gh.sh):
# one strategy across t3code/hermes/loop-agent so the pin and its
# checksum verification cannot drift between images (#23). Renovate bumps
# the ARG ("pinned build tools" group in renovate.json). Authentication is
# runtime-only: the image carries no token — gh reads GH_TOKEN/GITHUB_TOKEN
# from pod env (secretKeyRef, see deploy/github-tokens) or a mounted token
# file via workspace-lib setup_gh_cli — never anything baked into a layer.
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
ARG GH_VERSION=2.98.0
COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

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

# uv — work-repo pnpm installs hook into Python packaging
# (apps/document-processor's install script is `uv sync`), so `pnpm
# install` on a work clone fails without it. Pinned + checksum-verified
# per the pinned-build-tools convention (Renovate proposes bumps).
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=0.12.23
# Depot CLI — work CI builds images with `depot bake` on Depot-hosted
# runners; the CLI lets runner agents reproduce/inspect those builds.
# Inert without DEPOT_TOKEN (ExternalSecret on the work runner; absent
# item is the documented expected state).
# renovate: datasource=github-releases depName=depot/cli extractVersion=^v(?<version>.+)$
ARG DEPOT_VERSION=2.102.16
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in \
       x86_64|amd64) UARCH=x86_64; DARCH=amd64 ;; \
       arm64|aarch64) UARCH=aarch64; DARCH=arm64 ;; \
       *) echo "unsupported arch ${ARCH}" >&2; exit 1 ;; \
     esac \
  && uv_asset="uv-${UARCH}-unknown-linux-gnu.tar.gz" \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_asset}" -o "/tmp/${uv_asset}" \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_asset}.sha256" -o "/tmp/${uv_asset}.sha256" \
  && (cd /tmp && sha256sum -c "${uv_asset}.sha256") \
  && tar -xzf "/tmp/${uv_asset}" -C /tmp \
  && cp "/tmp/uv-${UARCH}-unknown-linux-gnu/uv" "/tmp/uv-${UARCH}-unknown-linux-gnu/uvx" /usr/local/bin/ \
  && uv --version \
  && depot_asset="depot_${DEPOT_VERSION}_linux_${DARCH}.tar.gz" \
  && curl -fsSL "https://github.com/depot/cli/releases/download/v${DEPOT_VERSION}/${depot_asset}" -o "/tmp/${depot_asset}" \
  && curl -fsSL "https://github.com/depot/cli/releases/download/v${DEPOT_VERSION}/depot_${DEPOT_VERSION}_checksums.txt" -o /tmp/depot_checksums.txt \
  && grep -F "${depot_asset}" /tmp/depot_checksums.txt > /tmp/depot-one.sha256 \
  && (cd /tmp && sha256sum -c depot-one.sha256) \
  && mkdir -p /tmp/depot-cli \
  && tar -xzf "/tmp/${depot_asset}" -C /tmp/depot-cli \
  && cp /tmp/depot-cli/bin/depot /usr/local/bin/depot \
  && depot --version \
  && rm -rf /tmp/uv* /tmp/depot*

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace

ENV DATA_DIR=/data
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
