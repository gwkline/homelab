FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace

ENV DATA_DIR=/data
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
