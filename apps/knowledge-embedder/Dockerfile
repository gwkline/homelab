# knowledge-embedder: OpenAI-compatible /embeddings sidecar for the knowledge
# services, serving BAAI/bge-small-en-v1.5 (384-d, fp32 ONNX) in-process.
# The model is baked in at a pinned revision, so the pod needs no egress and
# a rollout cannot change the model without changing this file.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/knowledge-embedder/package.json apps/knowledge-embedder/
RUN npm ci -w apps/knowledge-embedder --no-audit --no-fund
COPY apps/knowledge-embedder/ apps/knowledge-embedder/
RUN npm run build -w apps/knowledge-embedder

# The upstream files are only reachable at build time; the pinned revision
# makes the image reproducible and keeps the pod off the network.
ENV MODEL_REV=ea104dacec62c0de699686887e3f920caeb4f3e3 \
    MODEL_REPO=Xenova/bge-small-en-v1.5
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p model/onnx \
  && for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do \
       curl -fsSL "https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REV}/${f}" -o "model/${f}"; \
     done \
  && curl -fsSL "https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REV}/onnx/model.onnx" \
       -o "model/onnx/model.onnx"

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
ENV NODE_ENV=production
# @huggingface/transformers is the one runtime dependency, like pg for the
# knowledge services: esbuild cannot inline the native onnxruntime binding.
COPY package.json package-lock.json ./
COPY apps/knowledge-embedder/package.json apps/knowledge-embedder/
RUN npm ci -w apps/knowledge-embedder --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  # The node package ships binaries for every platform (~350 MiB of dead
  # weight here) and pulls the browser WASM runtime, which the node entry
  # point never imports (verified by tests/embed-smoke.test.ts running
  # against this layout).
  && rm -rf \
       node_modules/onnxruntime-node/bin/napi-v6/darwin \
       node_modules/onnxruntime-node/bin/napi-v6/win32 \
       node_modules/onnxruntime-web
COPY --from=build --chown=1000:1000 --chmod=0555 /src/apps/knowledge-embedder/dist ./dist
COPY --from=build /src/model ./model
# a=rX: read for all, execute bit on directories only, so the node user can
# traverse the model tree but nothing is writable.
RUN chmod -R a=rX /app/model
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
