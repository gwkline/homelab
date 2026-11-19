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

export const createEmbed = async (modelDir: string): Promise<Embed> => {
  // dtype fp32 — the full-precision ONNX file; int8 quantization measurably
  // degrades retrieval and the model is only 133 MiB.
  const extractor = await pipeline("feature-extraction", modelDir, {
    dtype: "fp32",
  });
  return async (inputs) => {
    const output = await extractor(inputs, { normalize: true, pooling: "cls" });
    return output.tolist() as number[][];
  };
};
