# Upstream distributes hermes-agent as an image (its setup.py refuses pip
# builds), so we build on their pinned release instead of installing from git.
# The tag is also digest-pinned so the base cannot change under us (#35).
FROM nousresearch/hermes-agent:v2026.8.19@sha256:3811ed13da874fba2ac99b6d492db9a203d34cb6dccf90d886948c00d0ccec09

# kubectl pinned to a recorded version (the stable.txt resolution at pin
# time — issue #35) and sha256-verified against dl.k8s.io's published
# checksum for that exact version.
# renovate: datasource=github-releases depName=kubernetes/kubernetes extractVersion=^v(?<version>.+)$
ARG KUBECTL_VERSION=1.37.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
  && curl -fsSLo /tmp/kubectl.sha256 \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" \
  && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
  && chmod +x /usr/local/bin/kubectl \
  && rm /tmp/kubectl.sha256

# gh CLI baked into the image via the shared installer (apps/shared/
# install-gh.sh): one strategy across t3code/hermes/loop-agent so the pin
# and its checksum verification cannot drift between images (#23) — exact
# release, sha256-verified against the checksums.txt published alongside it,
# arch-detected at build time (amd64 today, arm64 if the base gains that
# build). Renovate bumps the ARG; the next build re-verifies. Authentication
# is runtime-only: GH_TOKEN/GITHUB_TOKEN arrive via the StatefulSet env
# (secretKeyRef, deploy/github-tokens) — no token is baked into a layer.
# Before gh was baked in, it only existed in the agent's ad-hoc ~/bin on
# the PVC — a PVC wipe silently removed it, and non-interactive shells
# couldn't see it, pushing the agent toward hand-rolled credential exports
# (see run-hermes.sh scrub).
# renovate: datasource=github-releases depName=cli/cli extractVersion=^v(?<version>.+)$
ARG GH_VERSION=2.98.0
COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY apps/hermes/run-hermes.sh /usr/local/bin/run-hermes
COPY apps/hermes/check-skills-sync.sh /usr/local/bin/check-skills-sync
RUN chmod +x /usr/local/bin/run-hermes /usr/local/bin/check-skills-sync

# Photon sidecar runtime copy: the adapter resolves its sidecar dir to
# $HERMES_HOME/photon/sidecar and runs `npm ci` there on first connect, but
# the .mjs sources only exist in the plugin tree. Copy them in the entrypoint
# (not here) because HERMES_HOME is a PVC mounted at runtime — see
# run-hermes.sh.

ENV DATA_DIR=/data \
    HERMES_HOME=/data/hermes

ENTRYPOINT ["/usr/local/bin/run-hermes"]
