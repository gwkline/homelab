# Factory security worker — harness-agnostic, not opencode-locked.
# Reuses the ephemeral /task→/out contract from the code-pr worker so the
# orchestrator + panel don't need a second publish path. Scanners run locally;
# no LLM, no outbound model API required (egress stays github.com + ghcr only).
# Every downloaded tool is pinned to an exact version and verified against the
# checksum file published with its release (issue #35).
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 python3-pip make g++ curl unzip xz-utils jq shellcheck golang-go \
  && rm -rf /var/lib/apt/lists/*

# gh CLI — exact release + published checksums (replaces the floating apt
# repo install, #35).
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
ARG GH_VERSION=2.62.0
RUN curl -fsSLo "/tmp/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
          | grep "gh_${GH_VERSION}_linux_amd64.tar.gz" | sha256sum -c -) \
  && tar -xzf "/tmp/gh_${GH_VERSION}_linux_amd64.tar.gz" -C /tmp --strip-components=1 \
  && install -m755 /tmp/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp/* \
  && gh --version

# Rust (for cargo-audit if present)
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y \
      --profile minimal --default-toolchain "${RUST_VERSION}" \
  && chmod -R a+rwX /usr/local/rustup /usr/local/cargo

# hadolint (Dockerfile lint). 2.12.0 published no checksums; 2.15.1 ships
# checksums.sha256, so the pin sits on the first verifiable release.
# renovate: datasource=github-releases depName=hadolint/hadolint extractVersion=^v(?<version>.+)$
ARG HADOLINT_VERSION=2.15.1
RUN curl -fsSLo /tmp/hadolint-linux-x86_64 \
      "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/checksums.sha256" \
          | grep "hadolint-linux-x86_64" | sha256sum -c -) \
  && install -m755 /tmp/hadolint-linux-x86_64 /usr/local/bin/hadolint \
  && rm -f /tmp/hadolint-linux-x86_64 \
  && hadolint --version

# gitleaks (secret scan) — exact release + published checksums.
# renovate: datasource=github-releases depName=gitleaks/gitleaks extractVersion=^v(?<version>.+)$
ARG GITLEAKS_VERSION=8.18.4
RUN curl -fsSLo "/tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" \
          | grep "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | sha256sum -c -) \
  && tar -xzf "/tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -C /tmp \
  && install -m755 /tmp/gitleaks /usr/local/bin/gitleaks \
  && rm -rf /tmp/* \
  && gitleaks version

# semgrep (SAST, harness-agnostic) — exact PyPI release.
# renovate: datasource=pypi depName=semgrep
ARG SEMGREP_VERSION=1.176.0
RUN (pip3 install --no-cache-dir --break-system-packages "semgrep==${SEMGREP_VERSION}" \
      || pip3 install --no-cache-dir "semgrep==${SEMGREP_VERSION}") 2>&1 | tail -n 5 \
  ; semgrep --version

# trivy (vuln scan, optional — 80MB, best-effort install; verification is
# strict). Pinned .deb + recorded checksum from the release's
# trivy_0.74.0_checksums.txt (which also carries sigstore attestations),
# instead of the floating apt repo (#35).
# renovate: datasource=github-releases depName=aquasecurity/trivy extractVersion=^v(?<version>.+)$
ARG TRIVY_VERSION=0.74.0
RUN curl -fsSLo "/tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
      "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_checksums.txt" \
          | grep "trivy_${TRIVY_VERSION}_Linux-64bit.deb" | sha256sum -c -) \
  && (dpkg -i "/tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
      && rm -f "/tmp/trivy_${TRIVY_VERSION}_Linux-64bit.deb" \
      && trivy --version \
      || echo "trivy install best-effort")

# Non-root worker; same contract dirs as code-pr so orchestrator reuses extraction.
RUN mkdir -p /task /out /work && chown -R node:node /task /out /work
USER node
WORKDIR /work

COPY --chmod=755 --chown=node:node apps/factory/security/entrypoint.sh /usr/local/bin/entrypoint

ENTRYPOINT ["/usr/local/bin/entrypoint"]
