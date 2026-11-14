FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/panel/package.json apps/panel/
RUN npm ci -w apps/panel --no-audit --no-fund
COPY apps/panel/ apps/panel/
RUN npm run build -w apps/panel

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
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
