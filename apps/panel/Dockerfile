FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/panel/package.json apps/panel/
RUN npm ci -w apps/panel --no-audit --no-fund
COPY apps/panel/ apps/panel/
RUN npm run build -w apps/panel

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
WORKDIR /app
# dist/ is a self-contained bundle: no runtime node_modules.
ENV NODE_ENV=production \
    PANEL_ROOT=/app \
    PORT=3000
COPY --from=build /src/apps/panel/dist ./dist
COPY --from=build /src/apps/panel/web/dist ./web/dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
