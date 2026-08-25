FROM node:24-bookworm-slim

# python3/make/g++ exist for node-pty (native dep of t3) when no prebuild
# matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g t3@0.0.33

COPY apps/shared/workspace-lib.sh /usr/local/lib/workspace-lib.sh
COPY apps/t3code/init-workspace.sh /usr/local/bin/init-workspace
RUN chmod +x /usr/local/bin/init-workspace

ENV DATA_DIR=/data
EXPOSE 3773

ENTRYPOINT ["/usr/local/bin/init-workspace"]
