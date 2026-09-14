# Factory collector (#78): durable GitHub issue poller. Node-only — the
# collector speaks REST directly (pagination, conditional GETs and rate-limit
# handling live in apps/factory/collector/github-client.ts) instead of
# shelling out to gh, so untrusted issue content never crosses a shell
# boundary and eligibility decisions are pure data.
# Base image is digest-pinned (issue #35/#91): same base as panel/worker.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
# Zero runtime dependencies: type stripping runs the TS sources directly, so
# no npm install step exists to drift. token-service.ts keeps its
# repo-relative path so the collector's `../github-app/token-service.ts`
# import resolves identically in-image and in CI.
COPY apps/factory/collector/package.json apps/factory/collector/tsconfig.json /app/apps/factory/collector/
COPY apps/factory/collector/config.ts apps/factory/collector/github-client.ts apps/factory/collector/github-errors.ts apps/factory/collector/run-collector.ts /app/apps/factory/collector/
COPY apps/factory/collector/run-collector.sh /app/apps/factory/collector/run-collector.sh
COPY apps/factory/github-app/token-service.ts /app/apps/factory/github-app/token-service.ts
RUN chmod +x /app/apps/factory/collector/run-collector.sh
ENV NODE_ENV=production
ENTRYPOINT ["/app/apps/factory/collector/run-collector.sh"]
