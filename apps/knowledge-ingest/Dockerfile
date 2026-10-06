# Knowledge ingest API + worker — hono queue API (#58), pg SKIP LOCKED
# queue, and the real extract → chunk → embed → upsert pipeline over the
# #56 knowledge schema (git-source pulls need git in the runtime image).
# Base image is digest-pinned so a rebuild cannot silently pick up a new
# Debian point release (issue #35), matching apps/panel/Dockerfile.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
# The bundle imports the shared knowledge lib via ../../knowledge/src — keep
# the repo-shaped layout so those relative paths resolve inside the image.
WORKDIR /src
COPY apps/knowledge-ingest/package.json apps/knowledge-ingest/package-lock.json ./apps/knowledge-ingest/
RUN cd apps/knowledge-ingest && npm ci --no-audit --no-fund
COPY apps/knowledge/src ./apps/knowledge/src
COPY apps/knowledge-ingest/ ./apps/knowledge-ingest/
RUN cd apps/knowledge-ingest && npm run build

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
# git: the ingest worker clones/fetches knowledge sources (git-source).
# ca-certificates: https clones and url fetches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3100
# dist/index.js is the bundled service; pg stays external (native-optional
# dependency), so the runtime ships node_modules from the lockfile.
COPY apps/knowledge-ingest/package.json apps/knowledge-ingest/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=1000:1000 --chmod=0555 /src/apps/knowledge-ingest/dist ./dist
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT ?? 3100}/healthz`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "dist/index.js"]
