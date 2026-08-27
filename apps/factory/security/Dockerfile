# Factory security worker — harness-agnostic, not opencode-locked.
# Reuses the ephemeral /task→/out contract from the code-pr worker so the
# orchestrator + panel don't need a second publish path. Scanners run locally;
# no LLM, no outbound model API required (egress stays github.com + ghcr only).
FROM node:24-bookworm-slim

ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 python3-pip make g++ curl unzip xz-utils jq shellcheck golang-go \
  && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Rust (for cargo-audit if present)
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y \
      --profile minimal --default-toolchain "${RUST_VERSION}" \
  && chmod -R a+rwX /usr/local/rustup /usr/local/cargo

# hadolint (Dockerfile lint)
ARG HADOLINT_VERSION=2.12.0
RUN curl -fsSL "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-Linux-x86_64" \
      -o /usr/local/bin/hadolint && chmod +x /usr/local/bin/hadolint

# gitleaks (secret scan)
ARG GITLEAKS_VERSION=8.18.4
RUN curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
      | tar -xz -C /tmp && mv /tmp/gitleaks /usr/local/bin/gitleaks && chmod +x /usr/local/bin/gitleaks

# semgrep (SAST, harness-agnostic)
RUN pip3 install --no-cache-dir --break-system-packages semgrep 2>&1 | tail -n 5 || pip3 install --no-cache-dir semgrep 2>&1 | tail -n 5

# trivy (vuln scan, optional — 80MB, best-effort)
RUN curl -fsSL https://aquasecurity.github.io/trivy-repo/deb/public.key | gpg --dearmor | tee /usr/share/keyrings/trivy.gpg > /dev/null \
  && echo "deb [signed-by=/usr/share/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb generic main" \
      | tee /etc/apt/sources.list.d/trivy.list \
  && apt-get update && apt-get install -y --no-install-recommends trivy \
  && rm -rf /var/lib/apt/lists/* || echo "trivy install best-effort"

# Non-root worker; same contract dirs as code-pr so orchestrator reuses extraction.
RUN mkdir -p /task /out /work && chown -R node:node /task /out /work
USER node
WORKDIR /work

COPY --chmod=755 --chown=node:node apps/factory/security/entrypoint.sh /usr/local/bin/entrypoint

ENTRYPOINT ["/usr/local/bin/entrypoint"]
