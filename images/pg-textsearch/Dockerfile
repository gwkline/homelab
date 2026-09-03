# pg_textsearch extension image for CNPG ImageVolume delivery (homelab#48).
#
# Layout follows cloudnative-pg/postgres-extensions-containers: the .so ships
# under /lib, control + SQL under /share/extension. CNPG mounts each Cluster
# extensions[] entry at /extensions/<name> and appends those paths to
# dynamic_library_path / extension_control_path automatically.
#
# ABI: built against the exact operand in
# deploy/postgres/base/cluster-image-catalog.yaml (PostgreSQL 18,
# Debian trixie, amd64) — same base image, digest-pinned. Rebuild (and
# re-pin the digest in cluster.yaml) whenever the operand changes.
ARG BASE=ghcr.io/cloudnative-pg/postgresql:18.6-202608310817-minimal-trixie@sha256:5c389b0268d9e637ca55efa41a7fafa3996332b5ea3c6099d0861c5f31acb00e
FROM $BASE AS builder
USER 0

ARG PG_MAJOR=18
# timescale/pg_textsearch release pin (homelab#48): tag + release-asset hash.
ARG EXT_VERSION=1.4.0
ARG EXT_SHA256=313c231136f19ded24a7d6f4de3ca96f3840b10c55adbfc839cd0068042e2e40

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
