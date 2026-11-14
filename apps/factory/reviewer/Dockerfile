# Factory reviewer: GitHub-as-ledger poller, no model API.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl jq git python3 openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh
COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh

# Shared factory shell library and label list (apps/factory/lib).
COPY apps/factory/lib/factory.sh apps/factory/lib/labels.json /usr/local/lib/factory/
WORKDIR /reviewer
COPY apps/factory/reviewer/run-reviewer.sh /reviewer/run-reviewer.sh
COPY apps/factory/reviewer/run-sweeper.sh /reviewer/run-sweeper.sh
COPY apps/factory/medic/medic-lib.sh /reviewer/medic-lib.sh
COPY apps/factory/medic/run-medic.sh /reviewer/run-medic.sh
RUN chmod +x /reviewer/run-reviewer.sh /reviewer/run-sweeper.sh /reviewer/run-medic.sh
# The pods' runAsUser; the slim base has no user to name.
USER 1000:1000
ENTRYPOINT ["/reviewer/run-reviewer.sh"]
