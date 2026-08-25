FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY apps/panel/package.json apps/panel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/panel/ ./
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
# dist/ is a self-contained bundle: no runtime node_modules.
ENV NODE_ENV=production \
    PANEL_ROOT=/app \
    PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
