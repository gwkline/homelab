# Factory orchestrator image: kubectl + gh + jq + git in a slim shell.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 openssh-client \
  && rm -rf /var/lib/apt/lists/*
ARG KUBECTL_VERSION=1.31.3
RUN curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

ARG GH_VERSION=2.62.0
RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /tmp --strip-components=1 \
  && install -m755 /tmp/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp

WORKDIR /orch
COPY apps/factory/orchestrator/run.sh /orch/run.sh
RUN chmod +x /orch/run.sh
ENTRYPOINT ["/orch/run.sh"]
