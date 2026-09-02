# Factory collector — gh + jq only, no model API.
# Base image is digest-pinned so a rebuild cannot silently pick up a new
# Debian point release (issue #35).
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl jq coreutils \
  && rm -rf /var/lib/apt/lists/*
# gh: exact release, verified against the checksums.txt published with it.
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
  && rm -rf /tmp/* \
  && gh --version
WORKDIR /collector
COPY apps/factory/collector/run-collector.sh /collector/run-collector.sh
RUN chmod +x /collector/run-collector.sh
ENTRYPOINT ["/collector/run-collector.sh"]
