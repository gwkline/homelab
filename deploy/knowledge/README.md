# Knowledge

Two services in `agents` over the `knowledge` database ([deploy/postgres](../postgres/README.md)):

- `knowledge-ingest`: queue API (`/v1/ingest`, `/v1/sources`, `/v1/sync-jobs`) and a worker that fetches git sources or URLs, then chunks, embeds, and upserts. Cluster-internal only.
- `knowledge-retrieval`: `POST /v1/search` (BM25 + vector, RRF fusion, cited chunks), plus a passthrough to ingest so clients need one base URL. Exposed at `https://knowledge.<tailnet>`.

## Prerequisites

- `pg-primary` is healthy with the `knowledge` database.
- 1Password items `knowledge-db` and `knowledge-api-token` (contracts in `base/externalsecret.yaml`). Optionally `knowledge-search-token`, a read-only token that can only call `/v1/search`. The `knowledge-db` password must match Secret `database/pg-primary-knowledge-owner`.
- `github-token` in `agents` (for private git sources).

## Apply

```sh
kubectl apply -k deploy/knowledge/base
kubectl -n agents rollout status deploy/knowledge-ingest deploy/knowledge-retrieval
```

knowledge-ingest applies pending schema migrations on boot under a Postgres advisory lock. Retrieval never issues DDL; it answers 503 until the schema version it needs is in place, so the two can start in either order.

## Verify

```sh
TOKEN="$(kubectl -n agents get secret knowledge-api-token -o jsonpath='{.data.token}' | base64 -d)"
curl -sS -H "authorization: Bearer $TOKEN" \
  -d '{"query":"restart the postgres primary","namespace":"homelab-docs"}' \
  http://knowledge-retrieval-http.agents.svc:3000/v1/search
```

## Notes

No embedding model is configured yet. Ingest stores placeholder vectors tagged `fake/384`, and retrieval serves every search as BM25 (the response's `mode` says `bm25`). To turn on vector and hybrid search, set `KNOWLEDGE_EMBEDDING_PROVIDER=openai` and `KNOWLEDGE_EMBEDDING_BASE_URL` on both services, then re-embed. Until the re-embed, `knowledge_embedding_model_mismatch_chunks` on retrieval's `/metrics` counts the vectors the channel ignores.

Both services go NotReady (`/readyz`) while Postgres is unreachable and reconnect on their own. Pool size and statement timeouts are set by `KNOWLEDGE_INGEST_PG_POOL_MAX`, `KNOWLEDGE_INGEST_STATEMENT_TIMEOUT_MS`, `KNOWLEDGE_PG_POOL_MAX`, and `KNOWLEDGE_TIMEOUT_MS` (retrieval's request deadline doubles as its statement timeout). Finished ingest jobs drop their document text, and after `KNOWLEDGE_INGEST_JOB_RETENTION_DAYS` (14) they are deleted, except each source's latest sync and failure.
