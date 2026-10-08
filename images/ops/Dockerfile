# Utility image: the deployer CronJob and one-off Jobs (scripts/new-job.sh,
# scripts/egress-smoke.sh). Shell tools, kubectl, and node/npm for the probe
# and repo commands those Jobs run; no compilers, browsers or agent CLIs.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache ca-certificates curl git jq nodejs npm

COPY apps/shared/install-kubectl.sh /usr/local/lib/install-kubectl.sh
RUN sh /usr/local/lib/install-kubectl.sh

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY --chmod=755 images/ops/run-job.sh /usr/local/bin/run-job

# uid 1000, the runAsUser of every pod that runs this image. Its home is /tmp,
# the one writable path those pods mount (git config, kubectl's cache).
RUN addgroup -g 1000 ops && adduser -D -H -h /tmp -G ops -u 1000 ops
USER 1000:1000

ENV DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/run-job"]
