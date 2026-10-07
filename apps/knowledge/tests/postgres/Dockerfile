# Throwaway Postgres for the knowledge live suites in CI: the cluster's
# pg_textsearch build (images/pg-textsearch, the digest deploy/postgres pins)
# on pgvector's Postgres 18, at the cluster's vector version. Bump both pins
# with deploy/postgres/base.
FROM ghcr.io/gwkline/homelab/pg-textsearch@sha256:8076cc6902d6ebadbd66419988bd0612a3ca93ed0601eb6a5edd21857bca2790 AS ext
FROM pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff
COPY --from=ext /lib/pg_textsearch.so /usr/lib/postgresql/18/lib/
COPY --from=ext /share/extension/ /usr/share/postgresql/18/extension/
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
