FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir "hermes-agent @ git+https://github.com/NousResearch/hermes-agent.git" \
  && curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
  && chmod +x /usr/local/bin/kubectl

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/hermes/run-hermes.sh /usr/local/bin/run-hermes
RUN chmod +x /usr/local/bin/run-hermes

ENV DATA_DIR=/data \
    HERMES_HOME=/data/hermes

ENTRYPOINT ["/usr/local/bin/run-hermes"]
