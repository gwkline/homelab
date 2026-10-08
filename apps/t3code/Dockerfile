FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# python3/make/g++ build node-pty (a native dep of t3) when no prebuild
# matches the platform; g++ also links cargo builds. rsync and python3's
# sqlite3 save agent state to the PVC (agent-state.sh).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ curl unzip rsync \
  && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
COPY apps/shared/install-rust.sh /usr/local/lib/install-rust.sh
RUN sh /usr/local/lib/install-rust.sh

COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

# Read-only cluster inspection; the pod's ServiceAccount only gets get/list.
COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh

# uv: work-repo installs run `uv sync`. depot: reproduce work CI's
# `depot bake` builds (inert without DEPOT_TOKEN).
# Bump each version and its digests together.
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=0.12.23
ARG UV_SHA256_X86_64=9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6
ARG UV_SHA256_AARCH64=6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f
# renovate: datasource=github-releases depName=depot/cli extractVersion=^v(?<version>.+)$
ARG DEPOT_VERSION=2.102.16
ARG DEPOT_SHA256_AMD64=6e82427723c9f074b332ccb505a121f7f8594e9d6a5f11e2773ec7da767bc6ec
ARG DEPOT_SHA256_ARM64=6a44c71120ac5ceebeb7b02a554b31747529cbca3bc8808a04d36425376498dd
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in \
       x86_64|amd64) UARCH=x86_64; DARCH=amd64; UV_SHA256="${UV_SHA256_X86_64}"; DEPOT_SHA256="${DEPOT_SHA256_AMD64}" ;; \
       arm64|aarch64) UARCH=aarch64; DARCH=arm64; UV_SHA256="${UV_SHA256_AARCH64}"; DEPOT_SHA256="${DEPOT_SHA256_ARM64}" ;; \
       *) echo "unsupported arch ${ARCH}" >&2; exit 1 ;; \
     esac \
  && uv_asset="uv-${UARCH}-unknown-linux-gnu.tar.gz" \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_asset}" -o "/tmp/${uv_asset}" \
  && echo "${UV_SHA256}  /tmp/${uv_asset}" | sha256sum -c - \
  && tar -xzf "/tmp/${uv_asset}" -C /tmp \
  && cp "/tmp/uv-${UARCH}-unknown-linux-gnu/uv" "/tmp/uv-${UARCH}-unknown-linux-gnu/uvx" /usr/local/bin/ \
  && uv --version \
  && depot_asset="depot_${DEPOT_VERSION}_linux_${DARCH}.tar.gz" \
  && curl -fsSL "https://github.com/depot/cli/releases/download/v${DEPOT_VERSION}/${depot_asset}" -o "/tmp/${depot_asset}" \
  && echo "${DEPOT_SHA256}  /tmp/${depot_asset}" | sha256sum -c - \
  && mkdir -p /tmp/depot-cli \
  && tar -xzf "/tmp/${depot_asset}" -C /tmp/depot-cli \
  && cp /tmp/depot-cli/bin/depot /usr/local/bin/depot \
  && depot --version \
  && rm -rf /tmp/uv* /tmp/depot*

COPY apps/shared/install-agent-clis.sh /usr/local/lib/install-agent-clis.sh
RUN sh /usr/local/lib/install-agent-clis.sh

# t3 ships its binary as an optional npm dep that can lag a nightly publish;
# `t3 --version` fails the build instead of crash-looping the pod.
# renovate: datasource=npm depName=t3
ARG T3_VERSION=0.0.46-nightly.20261007.2787
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_BETA_VERSION=0.0.0-beta-202608110357
RUN npm install -g "t3@${T3_VERSION}" \
  && npm install -g --prefix /opt/opencode-v2 "opencode-ai@${OPENCODE_BETA_VERSION}" \
  && ln -sf /opt/opencode-v2/bin/opencode /usr/local/bin/opencode-beta \
  && opencode-beta --version \
  && t3 --version

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY apps/t3code/agent-state.sh /usr/local/lib/agent-state.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace

ENV DATA_DIR=/data
USER node
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
