# Factory coding worker: ephemeral, unattended, no server. Shares t3code's
# toolchain installers; differs by having no t3 serve, no pairing, no
# persistent volumes, and explicit /task (input) and /out (output) dirs.

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ curl unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}
COPY apps/shared/install-rust.sh /usr/local/lib/install-rust.sh
RUN sh /usr/local/lib/install-rust.sh

COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

# P-Stack agent workflows: the official Cursor plugin tree, pinned to an
# upstream commit.
ARG PSTACK_REPO=cursor/plugins
ARG PSTACK_REF=efa2a531985e0a8084d36ff3cf87233be8a9f34b
ARG PSTACK_VERSION=0.14.7
RUN curl -fsSL "https://codeload.github.com/${PSTACK_REPO}/tar.gz/${PSTACK_REF}" \
      -o /tmp/pstack.tar.gz \
  && mkdir -p /opt/pstack \
  && tar -xzf /tmp/pstack.tar.gz -C /opt/pstack --strip-components=2 --wildcards "*/pstack/*" \
  && test -f /opt/pstack/.cursor-plugin/plugin.json \
  && grep -q "\"version\": \"${PSTACK_VERSION}\"" /opt/pstack/.cursor-plugin/plugin.json \
  && grep -q "License" /opt/pstack/LICENSE \
  && rm /tmp/pstack.tar.gz

# Floating CLIs re-resolve on every CI build: CI passes a unique CACHEBUST so
# the layer cache cannot replay an old resolution.
ARG CACHEBUST=1
COPY apps/shared/install-agent-clis.sh /usr/local/lib/install-agent-clis.sh
RUN sh /usr/local/lib/install-agent-clis.sh

# Typed run-input schema and pinned verification skills (manifest.json
# carries the content sha the smoke test enforces).
COPY apps/factory/worker/brief.schema.json /usr/local/share/worker/brief.schema.json
COPY apps/factory/worker/skills /usr/local/share/worker/skills

# node:24 already ships the non-root node user (uid 1000). The agent runs
# untrusted text, so nothing in the image may raise privilege: strip every
# setuid/setgid bit the base image and packages ship (su, mount, ssh-keysign…).
RUN mkdir -p /task /out /work && chown -R node:node /task /out /work \
  && find / -xdev -type f -perm /6000 -exec chmod ug-s {} +
USER node
WORKDIR /work

COPY --chmod=755 --chown=node:node apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY --chmod=755 --chown=node:node apps/factory/worker/entrypoint.sh /usr/local/bin/entrypoint
# The Job's initContainer: clone + skills sync, the only step with a GitHub token.
COPY --chmod=755 --chown=node:node apps/factory/worker/prepare.sh /usr/local/bin/prepare
# Private skills the entrypoint syncs before the agent runs. A Job may
# override SKILLS_REF (full SHA, verified by the sync) or SKILLS_ALLOWLIST.
ENV SKILLS_REF=445e4255288732efb00c8878151610c2669f5e93 \
    SKILLS_ALLOWLIST="software-development/homelab-k3s-ops software-development/poteto-mode" \
    SKILLS_TARGET=/work/skills-generated \
    SKILLS_STATUS_FILE=/out/skills-sync.json
COPY --chmod=755 --chown=node:node apps/factory/worker/smoke-test.sh /usr/local/bin/smoke-test

ENTRYPOINT ["/usr/local/bin/entrypoint"]
