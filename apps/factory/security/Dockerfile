# Factory security worker: local scanners only, no model API. Shares the
# worker's /task -> /out contract so the orchestrator and panel reuse one
# publish path. Every scanner is pinned, downloads are verified against
# sha256 digests recorded here, and each must install or the build fails.
# Bump a version and its digest together.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 python3-pip make g++ curl unzip xz-utils jq shellcheck golang-go \
  && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
COPY apps/shared/install-rust.sh /usr/local/lib/install-rust.sh
RUN sh /usr/local/lib/install-rust.sh

COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

# kubectl kustomize renders deploy/ for the kustomize-verify section.
COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh

# renovate: datasource=github-releases depName=hadolint/hadolint extractVersion=^v(?<version>.+)$
ARG HADOLINT_VERSION=2.15.1
ARG HADOLINT_SHA256=c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
RUN curl -fsSLo /tmp/hadolint-linux-x86_64 \
      "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64" \
  && echo "${HADOLINT_SHA256}  /tmp/hadolint-linux-x86_64" | sha256sum -c - \
  && install -m755 /tmp/hadolint-linux-x86_64 /usr/local/bin/hadolint \
  && rm -f /tmp/hadolint-linux-x86_64 \
  && hadolint --version

# renovate: datasource=github-releases depName=gitleaks/gitleaks extractVersion=^v(?<version>.+)$
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
RUN curl -fsSLo "/tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  && echo "${GITLEAKS_SHA256}  /tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | sha256sum -c - \
  && tar -xzf "/tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -C /tmp \
  && install -m755 /tmp/gitleaks /usr/local/bin/gitleaks \
  && rm -rf /tmp/* \
  && gitleaks version

# PyPI publishes no checksum file; the exact version is asserted instead.
# renovate: datasource=pypi depName=semgrep
ARG SEMGREP_VERSION=1.185.0
RUN pip3 install --no-cache-dir --break-system-packages "semgrep==${SEMGREP_VERSION}" \
  && test "$(semgrep --version)" = "${SEMGREP_VERSION}"

# renovate: datasource=github-releases depName=aquasecurity/trivy extractVersion=^v(?<version>.+)$
ARG TRIVY_VERSION=0.76.2
ARG TRIVY_SHA256=7edaf64c8a2a0ae02137f776c6e56adf285fc36ec76b045274afdc462f20f092
RUN curl -fsSLo "/tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
      "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
  && echo "${TRIVY_SHA256}  /tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" | sha256sum -c - \
  && dpkg -i "/tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
  && rm -f "/tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
  && trivy --version

RUN mkdir -p /task /out /work && chown -R node:node /task /out /work
USER node
WORKDIR /work

COPY --chmod=755 --chown=root:root apps/factory/security/entrypoint.sh /usr/local/bin/entrypoint
# Shared with the code-pr worker: the Job's initContainer clone step.
COPY --chmod=755 --chown=root:root apps/factory/worker/prepare.sh /usr/local/bin/prepare

ENTRYPOINT ["/usr/local/bin/entrypoint"]
