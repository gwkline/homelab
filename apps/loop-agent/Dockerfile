FROM node:24-bookworm-slim

# Browser deps via Playwright, docker CLI for nested container work.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl xz-utils \
      docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && npx -y playwright@latest install --with-deps chromium

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/loop-agent/run-loop.sh /usr/local/bin/run-loop
RUN chmod +x /usr/local/bin/run-loop

ENV DATA_DIR=/data

ENTRYPOINT ["/usr/local/bin/run-loop"]
