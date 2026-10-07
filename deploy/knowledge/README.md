# Knowledge

Two services in `agents` over the `knowledge` database ([deploy/postgres](../postgres/README.md)):

- `knowledge-ingest`: queue API (`/v1/ingest`, `/v1/sources`, `/v1/sync-jobs`) and a worker that fetches git sources or URLs, then chunks, embeds, and upserts. Cluster-internal only.
- `knowledge-retrieval`: `POST /v1/search` (BM25 + vector, RRF fusion, cited chunks), plus a passthrough to ingest so clients need one base URL. Exposed at `https://knowledge.<tailnet>`.

## Prerequisites

- `pg-primary` is healthy with the `knowledge` database.
- 1Password items `knowledge-db` and `knowledge-api-token` (contracts in `base/externalsecret.yaml`). The `knowledge-db` password must match Secret `database/pg-primary-knowledge-owner`.
- `github-token` in `agents` (for private git sources).

## Apply

```sh
kubectl apply -k deploy/knowledge/base
kubectl -n agents rollout status deploy/knowledge-ingest deploy/knowledge-retrieval
```

The schema migrates idempotently on boot.

## Verify

```sh
TOKEN="$(kubectl -n agents get secret knowledge-api-token -o jsonpath='{.data.token}' | base64 -d)"
curl -sS -H "authorization: Bearer $TOKEN" \
  -d '{"query":"restart the postgres primary","namespace":"homelab-docs"}' \
  http://knowledge-retrieval-http.agents.svc:3000/v1/search
```

## Notes

Embeddings are deterministic and offline by default. Set `KNOWLEDGE_EMBEDDING_PROVIDER=openai` and `KNOWLEDGE_EMBEDDING_BASE_URL` to use a real model; ingest and retrieval must share the same setting.
