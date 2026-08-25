# Upstream distributes hermes-agent as an image (its setup.py refuses pip
# builds), so we build on their pinned release instead of installing from git.
FROM nousresearch/hermes-agent:v2026.8.19

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
  && chmod +x /usr/local/bin/kubectl

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/hermes/run-hermes.sh /usr/local/bin/run-hermes
RUN chmod +x /usr/local/bin/run-hermes

ENV DATA_DIR=/data \
    HERMES_HOME=/data/hermes

ENTRYPOINT ["/usr/local/bin/run-hermes"]
