FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# Fixed browsers path: identical for build (root) and runtime (uid 1000),
# independent of $HOME.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Browser deps: the playwright npm package is linked at /node_modules so ESM
# imports resolve from any /data/** repo path (resolution ascends to /);
# browsers install via that same pinned CLI. gh lets loops report back into
# GitHub (comments, issues) when a writer token is mounted; kubectl supports
# the dispatcher pattern. Neither has cluster credentials unless granted.
# kubectl is pinned to a recorded version (the stable.txt resolution at pin
# time — issue #35) and sha256-verified against dl.k8s.io's published
# checksum for that exact version.
# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.+)$
ARG KUBECTL_VERSION=1.37.0
# renovate: datasource=npm depName=playwright
ARG PLAYWRIGHT_VERSION=1.62.1
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
ARG GH_VERSION=2.98.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl xz-utils gnupg \
      docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSLo "/tmp/gh_${GH_VERSION}_linux_$(dpkg --print-architecture).tar.gz" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$(dpkg --print-architecture).tar.gz" \
  && (cd /tmp \
      && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
          | grep "gh_${GH_VERSION}_linux_$(dpkg --print-architecture).tar.gz" | sha256sum -c -) \
  && tar -xzf "/tmp/gh_${GH_VERSION}_linux_$(dpkg --print-architecture).tar.gz" -C /tmp --strip-components=1 \
  && install -m755 /tmp/bin/gh /usr/local/bin/gh \
  && rm -rf /tmp/* \
  && gh --version \
  && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
  && curl -fsSLo /tmp/kubectl.sha256 \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl.sha256" \
  && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl \
  && rm /tmp/kubectl.sha256 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/loop \
  && cd /opt/loop \
  && npm init -y >/dev/null \
  && npm install "playwright@${PLAYWRIGHT_VERSION}" \
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
