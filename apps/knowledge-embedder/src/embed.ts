/**
 * The transformers.js feature-extraction pipeline behind the HTTP surface,
 * kept separate so the app tests never need the model.
 *
 * bge-small-en-v1.5 pools the [CLS] token and L2-normalizes; inputs past the
 * model's 512-token limit are truncated by the tokenizer (verified: text
 * after the limit has no effect on the vector), and the chunker caps chunks
 * at 1200 chars, so real chunks sit well under the limit either way.
 */

import { pipeline } from "@huggingface/transformers";

/** One call, one vector per input, in order. */
export type Embed = (inputs: string[]) => Promise<number[][]>;

export const createEmbed = async (
  modelDir: string,
  options: { threads?: number } = {}
): Promise<Embed> => {
  // dtype fp32 — the full-precision ONNX file; int8 quantization measurably
  // degrades retrieval and the model is only 133 MiB.
  //
  // intraOpNumThreads must be pinned: onnxruntime defaults its thread pool to
  // the machine's core count, and a pool of spinning threads inside a small
  // CPU quota starves the actual matmuls (the first backfill ran at ~1
  // chunk/s on a 32-core node under a 1-core limit). Threads equal to the
  // pod's CPU limit keep the pool busy, not spinning.
  const threads =
    options.threads === undefined
      ? undefined
      : Math.max(1, Math.trunc(options.threads));
  const extractor = await pipeline("feature-extraction", modelDir, {
    dtype: "fp32",
    ...(threads === undefined
      ? {}
      : { session_options: { intraOpNumThreads: threads } }),
  });
  return async (inputs) => {
    const output = await extractor(inputs, { normalize: true, pooling: "cls" });
    return output.tolist() as number[][];
  };
};
