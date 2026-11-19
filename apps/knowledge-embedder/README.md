# knowledge-embedder

OpenAI-compatible `/embeddings` sidecar that turns on the knowledge base's vector search channel: `apps/knowledge`'s `KNOWLEDGE_EMBEDDING_PROVIDER=openai` points both knowledge services at it, and queries and chunks embed in-process with **BAAI/bge-small-en-v1.5** (384-d, fp32 ONNX via `@huggingface/transformers`). The model — the one `apps/knowledge`'s schema was designed around (`src/pgvector.ts`) — is baked into the image at a pinned revision, so no personal text ever leaves the cluster and a rollout cannot silently change the model. ADR-002 D6/D10: one model generation per index, and a model swap is a re-embed, not an in-place rewrite.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /embeddings` | `{input: string \| string[], model}` → `{data: [{embedding, index}], model, usage}` |
| `GET /healthz` | liveness |
| `GET /readyz` | 503 until the model has loaded |

No token: ingress is NetworkPolicy-gated to the `knowledge-ingest` and `knowledge-retrieval` pods, and the sidecar shares nothing with any other caller. Requests carry personal text, so logs record counts, dimensions and latency only — never the text.

## Env

| Variable | Default | Notes |
| --- | --- | --- |
| `KNOWLEDGE_EMBEDDER_PORT` | `8080` |  |
| `KNOWLEDGE_EMBEDDER_MODEL` | `BAAI/bge-small-en-v1.5` | must match what the callers send |
| `KNOWLEDGE_EMBEDDER_MODEL_DIR` | `/app/model` | local model directory |
| `KNOWLEDGE_EMBEDDER_MAX_BATCH` | `64` | the knowledge engine batches at most 32 |

The model pool is CLS + L2 normalize (the bge recipe); inputs past the tokenizer's 512-token limit truncate, and the chunker's 1200-char cap keeps real chunks far below that.

## Run

```sh
npm test -w apps/knowledge-embedder        # app-level tests, no model needed
npm run typecheck -w apps/knowledge-embedder
```

The model smoke test is opt-in (CI has no model checkout):

```sh
mkdir -p model/onnx && REV=ea104dacec62c0de699686887e3f920caeb4f3e3
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
  curl -fsSL "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/$REV/$f" -o "model/$f"
done
curl -fsSL "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/$REV/onnx/model.onnx" \
  -o model/onnx/model.onnx
KNOWLEDGE_EMBEDDER_MODEL_DIR="$PWD/model" npm test -w apps/knowledge-embedder
```

## Image notes

`node_modules` is stripped to what the node entry point imports: the non-linux `onnxruntime-node` binaries and the browser WASM runtime (`onnxruntime-web`) are removed after `npm ci` (~350 MiB). `sharp` stays — `@huggingface/transformers` statically imports it. The image lands around 350 MiB; a pod idles near 450 MiB RSS, so the Deployment requests 256 MiB and caps at 768 MiB.

## Deploy

Part of [deploy/knowledge/base](../../deploy/knowledge/README.md): one Deployment + Service in `agents`, netpol-gated to the two knowledge pods. The bge query instruction ("Represent this sentence for searching relevant passages") is a query-side-only lever — the document embeddings would not change — so it can be added later as a second route without a re-embed backfill; v1 embeds raw text on both sides, matching the service contract.
