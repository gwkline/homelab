# Throwaway Postgres for the knowledge live suites in CI: the cluster's
# pg_textsearch build (images/pg-textsearch, the digest deploy/postgres pins)
# on pgvector's Postgres 18, at the cluster's vector version. Bump both pins
# with deploy/postgres/base.
FROM ghcr.io/gwkline/homelab/pg-textsearch@sha256:8076cc6902d6ebadbd66419988bd0612a3ca93ed0601eb6a5edd21857bca2790 AS ext
FROM pgvector/pgvector:0.8.7-pg18-trixie@sha256:ab49524d18df7200b74ac9a475e1db6297fc1eb57da4c214c63d10ecc4b754fa
COPY --from=ext /lib/pg_textsearch.so /usr/lib/postgresql/18/lib/
COPY --from=ext /share/extension/ /usr/share/postgresql/18/extension/
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
