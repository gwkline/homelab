# Upstream distributes hermes-agent as an image (its setup.py refuses pip
# builds), so we build on their pinned release.
FROM nousresearch/hermes-agent:v2026.8.19@sha256:3811ed13da874fba2ac99b6d492db9a203d34cb6dccf90d886948c00d0ccec09

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh

# Baked in so every shell finds gh on PATH, independent of the PVC.
COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/shared/skills-lib.sh /usr/local/lib/skills-lib.sh
COPY apps/hermes/run-hermes.sh /usr/local/bin/run-hermes
COPY apps/hermes/check-skills-sync.sh /usr/local/bin/check-skills-sync
RUN chmod +x /usr/local/bin/run-hermes /usr/local/bin/check-skills-sync

# HERMES_HOME is a PVC, so run-hermes.sh (not this build) copies the Photon
# sidecar sources into $HERMES_HOME/photon/sidecar.
ENV DATA_DIR=/data \
    HERMES_HOME=/data/hermes

# The pod's runAsUser, not upstream's hermes user (10000): the PVC is owned
# by fsGroup 1000.
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/run-hermes"]
