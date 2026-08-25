FROM node:24-bookworm-slim

# Fixed browsers path: identical for build (root) and runtime (uid 1000),
# independent of $HOME.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Browser deps: the playwright npm package is linked at /node_modules so ESM
# imports resolve from any /data/** repo path (resolution ascends to /);
# browsers install via that same pinned CLI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl xz-utils \
      docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/loop \
  && cd /opt/loop \
  && npm init -y >/dev/null \
  && npm install playwright@1.62.1 \
  && ln -s /opt/loop/node_modules /node_modules \
  && /opt/loop/node_modules/.bin/playwright install --with-deps chromium
COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/loop-agent/run-loop.sh /usr/local/bin/run-loop
RUN chmod +x /usr/local/bin/run-loop

ENV DATA_DIR=/data

ENTRYPOINT ["/usr/local/bin/run-loop"]
