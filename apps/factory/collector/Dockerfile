# Factory collector — gh + jq only, no model API.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl jq coreutils \
  && rm -rf /var/lib/apt/lists/*
ARG GH_VERSION=2.62.0
RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /tmp --strip-components=1 \
  && install -m755 /tmp/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp
WORKDIR /collector
COPY apps/factory/collector/run-collector.sh /collector/run-collector.sh
RUN chmod +x /collector/run-collector.sh
ENTRYPOINT ["/collector/run-collector.sh"]
