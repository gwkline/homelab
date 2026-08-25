FROM node:24-bookworm-slim

# Fixed browsers path: identical for build (root) and runtime (uid 1000),
# independent of $HOME.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Browser deps: the playwright npm package is linked at /node_modules so ESM
# imports resolve from any /data/** repo path (resolution ascends to /);
# browsers install via that same pinned CLI. gh lets loops report back into
# GitHub (comments, issues) when a writer token is mounted; kubectl supports
# the dispatcher pattern. Neither has cluster credentials unless granted.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl xz-utils gnupg \
      docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" \
  && chmod +x /usr/local/bin/kubectl \
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
