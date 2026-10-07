FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# gcc/libc6-dev/make: the slim base has no linker, which cargo needs.
# pkg-config/libssl-dev cover the common openssl-sys dep.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl xz-utils gnupg \
      gcc libc6-dev make pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

# Fixed browsers path: identical for build (root) and runtime (uid 1000).
# playwright is linked at /node_modules so ESM imports resolve from any
# /data/** repo path.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# renovate: datasource=npm depName=playwright
ARG PLAYWRIGHT_VERSION=1.62.1
RUN mkdir -p /opt/loop \
  && cd /opt/loop \
  && npm init -y >/dev/null \
  && npm install "playwright@${PLAYWRIGHT_VERSION}" \
  && ln -s /opt/loop/node_modules /node_modules \
  && /opt/loop/node_modules/.bin/playwright install --with-deps chromium

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
COPY apps/shared/install-rust.sh /usr/local/lib/install-rust.sh
RUN sh /usr/local/lib/install-rust.sh

COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/loop-agent/run-loop.sh /usr/local/bin/run-loop
RUN chmod +x /usr/local/bin/run-loop

ENV DATA_DIR=/data

ENTRYPOINT ["/usr/local/bin/run-loop"]
