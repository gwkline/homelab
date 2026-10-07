# Knowledge — retrieval + ingest services (ADR-002)

The deployed knowledge vertical: two services in `agents` over the `knowledge` database (deploy/postgres, pgvector + pg_textsearch extensions installed declaratively by the CNPG `Database` resource).

| Service | Image | What it does |
| --- | --- | --- |
| `knowledge-ingest` | `ghcr.io/gwkline/homelab/knowledge-ingest` | Queue API (`/v1/ingest`, `/v1/sources`, `/v1/sync-jobs`) + the real worker: claim → route (git-source sync / git blob fetch / url fetch) → chunk → embed → upsert into the #56 schema → ledger publish. |
| `knowledge-retrieval` | `ghcr.io/gwkline/homelab/knowledge-retrieval` | `POST /v1/search` (BM25 + vector → RRF fusion, cited chunks), plus the `/v1/sources` + `/v1/sync-jobs` passthrough to ingest so the panel and MCP use one base URL. |

`apps/knowledge-mcp` is **not** deployed: it is a local stdio CLI (run by t3code/agents against `KNOWLEDGE_API_BASE=https://knowledge.<tailnet>`); no Dockerfile by design.

## Prerequisites

1. The postgres cluster (deploy/postgres) healthy, with the `knowledge` database + extensions (`pg-primary-knowledge` `Database` resource).
2. The `knowledge-db` 1Password item (username `knowledge_owner` + the same password as the `pg-primary-knowledge-owner` basic-auth Secret in the `database` namespace) and the `knowledge-api-token` item — see `base/externalsecret.yaml` for the item contracts and `docs/secrets-inventory.md` for rotation ownership.
3. The `onepassword` SecretStore in `agents` (deploy/eso).

## Bring-up

```sh
kubectl apply -k deploy/knowledge/base
kubectl -n agents rollout status deploy/knowledge-ingest deploy/knowledge-retrieval
```

Both services apply their idempotent schemas on boot (queue tables first, then the #56 knowledge schema + channel indexes — ordering documented in `apps/knowledge-ingest/server/queue.ts`), so the first healthy pod migrates the database.

Seed a source (the homelab docs repo, via the ingest API), then verify:

```sh
TOKEN="$(kubectl -n agents get secret knowledge-api-token -o jsonpath='{.data.token}' | base64 -d)"
curl -sS -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"contentHash":"<sha256>","externalId":"README.md","namespace":"homelab-docs","source":{"kind":"github","path":"README.md","ref":"main","repo":"gwkline/homelab","sourceId":"homelab-docs","url":"https://github.com/gwkline/homelab"},"version":{"versionId":"v1"}}' \
  http://knowledge-ingest.agents.svc.cluster.local:3100/v1/ingest
curl -sS -X POST -H "authorization: Bearer $TOKEN" \
  http://knowledge-retrieval.agents.svc.cluster.local:3000/v1/sources/homelab-docs/sync
curl -sS -H "authorization: Bearer $TOKEN" \
  -d '{"query":"restart the postgres primary","namespace":"homelab-docs"}' \
  http://knowledge-retrieval.agents.svc.cluster.local:3000/v1/search
```

## Configuration

Ingest env (`apps/knowledge-ingest/server/config.ts` + the shared `KNOWLEDGE_EMBEDDING_*` knobs in `apps/knowledge/src/embedder.ts`): token file, DATABASE_URL, worker tuning (claim batch, lease seconds, poll, retries), embedding provider (deterministic offline by default; point `KNOWLEDGE_EMBEDDING_PROVIDER=openai` + `KNOWLEDGE_EMBEDDING_BASE_URL` at a self-hosted embeddings server when one lands).

Retrieval env (`apps/knowledge-retrieval/server/config.ts`): token file, DATABASE_URL, ingest passthrough base + timeout, mode/topK/namespace defaults. Query embeddings use the same `KNOWLEDGE_EMBEDDING_*` provider configuration as the ingest worker — one model generation, always.

## Network

`base/netpol-knowledge.yaml` scopes both pods: egress to kube-dns, the database (5432), and (ingest only) public 443 for git pulls and the embedding provider; retrieval additionally reaches the ingest service (3100). Ingress: panel → both; Tailscale proxies → retrieval (the `https://knowledge.<tailnet>` entrypoint); ingest stays cluster-internal. The database side already allows SQL clients from `agents` (deploy/postgres/base/netpol.yaml `allow-sql-clients`).
