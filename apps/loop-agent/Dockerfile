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

# Rust toolchain so cargo repos (e.g. launchpad) build out of the box.
# System-wide install under /usr/local: uid 1000 gets it at runtime with no
# per-user rustup. The slim base has no C toolchain, so gcc/libc-dev are
# added here too — without a linker every `cargo build` fails immediately.
# pkg-config/libssl-dev cover the common openssl-sys dep.
ARG RUST_VERSION=1.98.0
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      gcc libc6-dev make pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" --no-modify-path \
  && chmod -R a+rX "${RUSTUP_HOME}" "${CARGO_HOME}" \
  && cargo --version

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/loop-agent/run-loop.sh /usr/local/bin/run-loop
RUN chmod +x /usr/local/bin/run-loop

ENV DATA_DIR=/data

ENTRYPOINT ["/usr/local/bin/run-loop"]
