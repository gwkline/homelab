# Factory orchestrator image: kubectl + gh + jq + git in a slim shell.
# Base image is digest-pinned; kubectl and gh are pinned to exact releases
# and sha256-verified against their published checksums (issue #35).
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/bin/git /usr/local/bin/git
# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.+)$
ARG KUBECTL_VERSION=1.31.3
RUN curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl \
  && curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" \
      -o /tmp/kubectl.sha256 \
  && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl && rm /tmp/kubectl.sha256

# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
ARG GH_VERSION=2.62.0
RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSLo "/tmp/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
          | grep "gh_${GH_VERSION}_linux_${ARCH}.tar.gz" | sha256sum -c -) \
  && tar -xzf "/tmp/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -C /tmp --strip-components=1 \
  && install -m755 /tmp/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp \
  && gh --version

WORKDIR /orch
COPY apps/factory/orchestrator/run.sh apps/factory/orchestrator/approval.sh /orch/
RUN chmod +x /orch/run.sh /orch/approval.sh
ENTRYPOINT ["/orch/run.sh"]
