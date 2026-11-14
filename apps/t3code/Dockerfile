FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
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
ARG UV_VERSION=0.13.8
ARG UV_SHA256_X86_64=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91
ARG UV_SHA256_AARCH64=74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585
# renovate: datasource=github-releases depName=depot/cli extractVersion=^v(?<version>.+)$
ARG DEPOT_VERSION=2.103.13
ARG DEPOT_SHA256_AMD64=342d19d914a5f31045f9fcc8fd462a140a73cac5c278e7838eb645f1075e7326
ARG DEPOT_SHA256_ARM64=2537d9342eecaed93a5e831d684006e2a7330d4a3e11d6a96eff751d1757d498
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
ARG T3_VERSION=0.1.10-nightly.20261113.4656
# renovate: datasource=npm depName=opencode-ai
ARG OPENCODE_BETA_VERSION=0.0.0-beta-202608110357
RUN npm install -g "t3@${T3_VERSION}" \
  && npm install -g --prefix /opt/opencode-v2 "opencode-ai@${OPENCODE_BETA_VERSION}" \
  && ln -sf /opt/opencode-v2/bin/opencode /usr/local/bin/opencode-beta \
  && opencode-beta --version \
  && t3 --version

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY apps/shared/work_resource_guard.py /usr/local/lib/work_resource_guard.py
COPY apps/shared/install_work_build_shims.py /usr/local/lib/install_work_build_shims.py
COPY apps/shared/work-build-shim.py /usr/local/lib/work-build-shim.py
COPY apps/shared/work-resource-guard-profile.sh /etc/profile.d/work-resource-guard.sh
COPY apps/t3code/agent-state.sh /usr/local/lib/agent-state.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace /usr/local/lib/work-build-shim.py

ENV DATA_DIR=/data
USER node
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
