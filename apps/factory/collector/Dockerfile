# Factory collector: admits open GitHub issues as factory Runs. TypeScript
# run directly via type stripping, so there is no npm install step.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
# token-service.ts keeps its repo-relative path so the collector's
# ../github-app/token-service.ts import resolves the same in-image and in CI.
COPY apps/factory/collector/package.json apps/factory/collector/tsconfig.json apps/factory/collector/config.ts apps/factory/collector/github-client.ts apps/factory/collector/github-errors.ts apps/factory/collector/run-collector.ts /app/apps/factory/collector/
COPY apps/factory/github-app/token-service.ts /app/apps/factory/github-app/token-service.ts
COPY apps/factory/lib/labels.json /app/apps/factory/lib/labels.json
ENV NODE_ENV=production
ENTRYPOINT ["node", "--experimental-strip-types", "/app/apps/factory/collector/run-collector.ts"]
