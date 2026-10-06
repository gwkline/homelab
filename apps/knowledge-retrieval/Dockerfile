# Knowledge retrieval API — hybrid BM25 (pg_textsearch) + vector (pgvector)
# retrieval over the #56 knowledge schema, RRF fusion, and the sources/sync
# passthrough to the ingest service. Stateless; falls back to the in-memory
# store when DATABASE_URL is unset (dev), so the image works offline too.
# Base image is digest-pinned so a rebuild cannot silently pick up a new
# Debian point release (issue #35), matching apps/panel/Dockerfile.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
COPY apps/knowledge-retrieval/package.json apps/knowledge-retrieval/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/knowledge-retrieval/ ./
RUN npm run build

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
# dist/index.js is the bundled service; pg stays external (native-optional
# dependency), so the runtime ships node_modules from the lockfile.
COPY apps/knowledge-retrieval/package.json apps/knowledge-retrieval/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=1000:1000 --chmod=0555 /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/healthz`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "dist/index.js"]
