# pg_textsearch extension image for CNPG ImageVolume delivery.
#
# Layout follows cloudnative-pg/postgres-extensions-containers: the .so ships
# under /lib, control + SQL under /share/extension. CNPG mounts each Cluster
# extensions[] entry at /extensions/<name> and appends those paths to
# dynamic_library_path / extension_control_path automatically.
#
# ABI: BASE must be the exact operand image in
# deploy/postgres/base/cluster-image-catalog.yaml. Rebuild (and re-pin this
# image's digest in cluster.yaml) whenever the operand changes.
ARG BASE=ghcr.io/cloudnative-pg/postgresql:18.7-202611122305-minimal-trixie@sha256:b98ae0b74a12f20ccff32219be0e33fdd35c7e2e8e73c8bff9173f1128e167d1
FROM $BASE AS builder
# Build stage only; the shipped stage runs as 65532.
# hadolint ignore=DL3002
USER 0
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG PG_MAJOR=18
# timescale/pg_textsearch release: tag + release-asset hash. Bump both together.
# renovate: datasource=github-releases depName=timescale/pg_textsearch extractVersion=^v(?<version>.+)$
ARG EXT_VERSION=1.5.1
ARG EXT_SHA256=5b90a160c4aa9ab78c72ab41eb761146a601485bff5e271f05a44d3da7493d5b

# Build deps come from the image's own apt sources (Debian snapshot +
# PGDG trixie-pgdg, both preconfigured in the operand image).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
       build-essential "postgresql-server-dev-${PG_MAJOR}" \
  && curl -fsSL -o /tmp/pg_textsearch.tar.gz \
       "https://github.com/timescale/pg_textsearch/releases/download/v${EXT_VERSION}/pg_textsearch-${EXT_VERSION}.tar.gz" \
  && echo "${EXT_SHA256}  /tmp/pg_textsearch.tar.gz" | sha256sum -c - \
  && mkdir -p /tmp/build && tar -xzf /tmp/pg_textsearch.tar.gz -C /tmp/build --strip-components=1 \
  && make -C /tmp/build -j"$(nproc)" PG_CONFIG="/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config" \
  && make -C /tmp/build install PG_CONFIG="/usr/lib/postgresql/${PG_MAJOR}/bin/pg_config" DESTDIR=/ext-staging \
  && test -f "/ext-staging/usr/lib/postgresql/${PG_MAJOR}/lib/pg_textsearch.so" \
  && test -f "/ext-staging/usr/share/postgresql/${PG_MAJOR}/extension/pg_textsearch.control" \
  && rm -rf /tmp/pg_textsearch.tar.gz /tmp/build

FROM scratch
COPY --from=builder /ext-staging/usr/lib/postgresql/18/lib/pg_textsearch.so /lib/
COPY --from=builder /ext-staging/usr/share/postgresql/18/extension/pg_textsearch* /share/extension/
USER 65532:65532
