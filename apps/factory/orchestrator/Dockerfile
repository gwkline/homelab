# Factory orchestrator: kubectl + gh + jq + git in a slim shell.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/bin/git /usr/local/bin/git

COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh
COPY apps/shared/install-gh.sh /usr/local/lib/install-gh.sh
RUN sh /usr/local/lib/install-gh.sh

WORKDIR /orch
COPY apps/factory/orchestrator/run.sh apps/factory/orchestrator/approval.sh apps/factory/orchestrator/marker.sh apps/factory/orchestrator/knowledge-context.sh apps/factory/orchestrator/run-reclaimer.sh apps/factory/orchestrator/worker-job.jq /orch/
RUN chmod +x /orch/run.sh /orch/approval.sh /orch/knowledge-context.sh /orch/run-reclaimer.sh
ENTRYPOINT ["/orch/run.sh"]
