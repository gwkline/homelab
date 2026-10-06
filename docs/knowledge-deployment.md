# Knowledge deployment — bootstrap record (ADR-002 vertical completion)

The knowledge vertical (ingest pipeline, retrieval Postgres store, MCP adapter, panel card, CI, manifests) landed as ONE pull request, with one deliberately deferred step: **pinning the service image digests**. This file is the record and the ready-to-paste follow-up PR body — keep it until the repin PR merges, then this file's "Follow-up" section can shrink to a pointer at `deploy/knowledge/README.md`.

## Why the digest pin cannot be in the same PR

CI publishes `ghcr.io/gwkline/homelab/knowledge-ingest` and `…/knowledge-retrieval` from the Dockerfiles added in this PR, but only after it merges to `main`. A manifest cannot reference a digest that does not exist yet, and `scripts/check-image-pins.sh` (correctly) refuses any homelab image ref that is not a 64-hex `@sha256:` pin. The repo's established answer is the **all-zero placeholder digest** — the same bootstrap `deploy/postgres` used for the pg-textsearch image: the manifests carry `@sha256:000…0`, which satisfies the pin checks but cannot pull, and the README + this file say exactly what to do next. The pods CrashLoop on ImagePullBackOff until the repin lands — expected, visible, and one command away.

## Follow-up PR (file immediately after CI publishes the images)

> **Re-pin knowledge services to the published digests**
>
> The knowledge vertical (ADR-002) landed with placeholder image digests; main CI has now published both images. This PR stamps the real digests:
>
> ```sh
> scripts/pin-factory-image.sh knowledge/ingest    "$(gh api 'users/gwkline/packages/container/homelab%2Fknowledge-ingest/versions?per_page=1' --jq '.[0].name')"
> scripts/pin-factory-image.sh knowledge/retrieval "$(gh api 'users/gwkline/packages/container/homelab%2Fknowledge-retrieval/versions?per_page=1' --jq '.[0].name')"
> ```
>
> No other changes — `scripts/check-image-pins.sh` stays green (the placeholders were valid pins), kustomize builds unchanged, and the auto-deploy watcher rolls both Deployments out on merge.

## Prerequisites that are NOT in this PR (operator actions)

1. **1Password items** (see `deploy/knowledge/base/externalsecret.yaml` + `docs/secrets-inventory.md` B7/B8):
   - `knowledge-db` — fields `username` (`knowledge_owner`), `password` (**the same password** as the `pg-primary-knowledge-owner` basic-auth Secret in the `database` namespace);
   - `knowledge-api-token` — field `token` (`openssl rand -base64 32`).
2. The postgres cluster healthy with the `knowledge` database + pgvector + pg_textsearch (`deploy/postgres`).
3. After the repin PR merges: `kubectl -n agents rollout status deploy/knowledge-ingest deploy/knowledge-retrieval`, then seed a source and verify (commands in `deploy/knowledge/README.md`).

## What landed where

| Piece | Location |
| --- | --- |
| Real pipeline handler (route by kind/source: git sync, git blob fetch, url fetch, hash verify → chunk → embed → upsert) | `apps/knowledge-ingest/server/pipeline-worker.ts`, `git-sync.ts`, `git-fetch.ts`, `knowledge-sink.ts` |
| Queue schema additions (`document-version` kind, `ingest_document` ledger rename, `git_source_manifest`) | `apps/knowledge-ingest/server/queue.ts` |
| Postgres retrieval store (BM25 + vector channels, live-document citation join) | `apps/knowledge-retrieval/server/pg-store.ts` |
| Ingest passthrough (one base URL for panel/MCP) | `apps/knowledge-retrieval/server/app.ts` |
| MCP adapter tests + testable server factory | `apps/knowledge-mcp/server.ts`, `tests/tools.test.ts` |
| Dockerfiles (digest-pinned base, non-root, healthcheck; git in the ingest image) | `apps/knowledge-ingest/Dockerfile`, `apps/knowledge-retrieval/Dockerfile` |
| CI: test jobs (ingest/retrieval/mcp) wired into `build.needs` + build matrix entries | `.github/workflows/ci.yaml` |
| Deploy manifests (Deployments, Services incl. tailscale LB, netpols, ExternalSecrets, placeholder digests) | `deploy/knowledge/base/` |
| Panel enablement (Knowledge card + server proxy env/token) | `apps/panel/server/devtools.ts`, `deploy/panel/base/deployment.yaml` |
| One-command repin | `scripts/pin-factory-image.sh` (knowledge components) |

## Deferred (documented, not forgotten)

- **GC job + re-embed backfill runner** (ADR-002 D14 #6): tombstoning is implemented end to end (git deletes/renames → `document.deleted_at` + chunk supersede), but the ≥7-day hard-delete GC and the backfill driver for `countChunksNeedingBackfill` are follow-ups.
- **Tags**: the #56 schema has no tag column; retrieval returns empty `tags` and a tag filter is an honest empty (`apps/knowledge-retrieval/server/pg-store.ts`).
- **`version.commit` on citations**: the #56 `document_version` row records content identity; surfacing the git commit on retrieval results needs a schema addition.
- **url/web crawlers**: `source_sync` for non-git sources is a documented no-op; those sources ingest via explicit events.
- **MCP as a service**: `apps/knowledge-mcp` is a local stdio CLI by design (no Dockerfile); deploy it only if a headless agent host needs it.
