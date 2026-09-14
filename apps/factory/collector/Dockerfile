# Factory collector (#78): durable GitHub issue poller. The GitHub ledger
# collector is TypeScript and speaks REST directly (pagination, conditional
# GETs and rate-limit handling live in apps/factory/collector/github-client.ts)
# instead of shelling out to gh, so untrusted issue content never crosses a
# shell boundary and eligibility decisions are pure data. The Linear input
# adapter (#87) stays a POSIX shell script — it selects via CronJob command
# override — so the image also carries gh + jq + curl for it.
# Base image is digest-pinned (issue #35/#91): same base as panel/worker.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl jq coreutils \
  && rm -rf /var/lib/apt/lists/*
# gh: exact release, verified against the checksums.txt published with it
# (used by run-linear-collector.sh only, not by the TS collector).
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
WORKDIR /app
# Both factory input adapters ship in this one image: the GitHub ledger
# collector (default entrypoint, zero runtime npm dependencies — type
# stripping runs the TS sources directly, so no npm install step exists
# to drift) and the Linear input adapter (#87). token-service.ts keeps
# its repo-relative path so the collector's ../github-app/token-service.ts
# import resolves identically in-image and in CI.
COPY apps/factory/collector/package.json apps/factory/collector/tsconfig.json /app/apps/factory/collector/
COPY apps/factory/collector/config.ts apps/factory/collector/github-client.ts apps/factory/collector/github-errors.ts apps/factory/collector/run-collector.ts /app/apps/factory/collector/
COPY apps/factory/collector/run-collector.sh /app/apps/factory/collector/run-collector.sh
COPY apps/factory/collector/run-linear-collector.sh /app/apps/factory/collector/run-linear-collector.sh
COPY apps/factory/github-app/token-service.ts /app/apps/factory/github-app/token-service.ts
RUN chmod +x /app/apps/factory/collector/run-collector.sh /app/apps/factory/collector/run-linear-collector.sh
ENV NODE_ENV=production
ENTRYPOINT ["/app/apps/factory/collector/run-collector.sh"]
