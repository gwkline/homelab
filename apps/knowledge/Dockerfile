# Knowledge services, one image: dist/ingest.js (queue, worker, git sync;
# port 3100) and dist/retrieval.js (hybrid search; port 3000). Each Deployment
# picks its entrypoint with `command`.
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/knowledge/package.json apps/knowledge/
RUN npm ci -w apps/knowledge --no-audit --no-fund
COPY apps/knowledge/ apps/knowledge/
RUN npm run build -w apps/knowledge

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
# git: ingest clones knowledge sources; ca-certificates serves https.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# The bundles inline everything except pg (native-optional), the package's
# only runtime dependency, so this installs pg and nothing else.
COPY package.json package-lock.json ./
COPY apps/knowledge/package.json apps/knowledge/
RUN npm ci -w apps/knowledge --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=1000:1000 --chmod=0555 /src/apps/knowledge/dist ./dist
USER node
EXPOSE 3000 3100
CMD ["node", "dist/retrieval.js"]
