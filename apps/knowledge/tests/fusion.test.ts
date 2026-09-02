import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_RRF_K, fuseReciprocalRank } from "../src/fusion.ts";
import type { ChannelRanking, FusedCandidate } from "../src/fusion.ts";

// Sum 1/(k + rank) exactly like fuseReciprocalRank does (in the order given,
// which for two-channel candidates is sorted channel order: bm25 then vector).
const rrf = (k: number, ...ranks: number[]): number => {
  let score = 0;
  for (const rank of ranks) {
    score += 1 / (k + rank);
  }
  return score;
};

const ids = (fused: FusedCandidate[]): string[] => fused.map((c) => c.chunkId);

const approx = (actual: number, expected: number): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `score ${actual} not within 1e-12 of ${expected}`
  );
};

const ranking = (channel: string, candidates: string[]): ChannelRanking => ({
  candidates,
  channel,
});

test("disjoint lists: single-channel candidates stay eligible with their own rank", () => {
  const fused = fuseReciprocalRank([
    ranking("bm25", ["alpha", "beta"]),
    ranking("vector", ["gamma", "delta"]),
  ]);

  // alpha and gamma tie at 1/(k+1) -> chunk id breaks the tie; likewise beta/delta.
  assert.deepEqual(ids(fused), ["alpha", "gamma", "beta", "delta"]);
  approx(fused[0]?.score ?? 0, rrf(DEFAULT_RRF_K, 1));
  approx(fused[1]?.score ?? 0, rrf(DEFAULT_RRF_K, 1));
  approx(fused[2]?.score ?? 0, rrf(DEFAULT_RRF_K, 2));
  approx(fused[3]?.score ?? 0, rrf(DEFAULT_RRF_K, 2));
  assert.deepEqual(fused[0]?.ranks, { bm25: 1 });
  assert.deepEqual(fused[1]?.ranks, { vector: 1 });
});

test("identical lists: duplicates collapse to one chunk with both source ranks", () => {
  const lists = ["doc-1", "doc-2", "doc-3"];
  const fused = fuseReciprocalRank([
    ranking("bm25", lists),
    ranking("vector", lists),
  ]);

  assert.equal(fused.length, 3, "not 6: duplicates collapse");
  assert.deepEqual(ids(fused), ["doc-1", "doc-2", "doc-3"]);
  approx(fused[0]?.score ?? 0, rrf(DEFAULT_RRF_K, 1, 1));
  approx(fused[1]?.score ?? 0, rrf(DEFAULT_RRF_K, 2, 2));
  approx(fused[2]?.score ?? 0, rrf(DEFAULT_RRF_K, 3, 3));
  assert.deepEqual(fused[0]?.ranks, { bm25: 1, vector: 1 });
  assert.deepEqual(fused[2]?.ranks, { bm25: 3, vector: 3 });
});

test("ties resolve deterministically: best rank, then chunk id", () => {
  // mid (bm25 #1) vs oak (vector #1): same score, same best rank -> id order.
  const crossChannel = fuseReciprocalRank([
    ranking("bm25", ["mid", "notch"]),
    ranking("vector", ["oak"]),
  ]);
  assert.deepEqual(ids(crossChannel), ["mid", "oak", "notch"]);

  // poppy: bm25 #1 + vector #2; quill: bm25 #2 + vector #1 — equal scores,
  // equal best rank -> chunk id decides. Input list order must not matter.
  const first = fuseReciprocalRank([
    ranking("bm25", ["poppy", "quill"]),
    ranking("vector", ["quill", "poppy"]),
  ]);
  const flipped = fuseReciprocalRank([
    ranking("vector", ["quill", "poppy"]),
    ranking("bm25", ["poppy", "quill"]),
  ]);
  assert.deepEqual(ids(first), ["poppy", "quill"]);
  assert.deepEqual(first, flipped);
  approx(first[0]?.score ?? 0, rrf(DEFAULT_RRF_K, 1, 2));
  approx(first[1]?.score ?? 0, rrf(DEFAULT_RRF_K, 2, 1));
});

test("short lists survive the window and long lists get truncated per channel", () => {
  // Shared chunk sits at rank 3 in bm25 but rank 1 in vector; with the default
  // window everything is kept (5 unique chunks).
  const bm25 = ["w1", "w2", "shared"];
  const vector = ["shared", "w3", "w4"];
  const full = fuseReciprocalRank([
    ranking("bm25", bm25),
    ranking("vector", vector),
  ]);
  assert.deepEqual(ids(full), ["shared", "w1", "w2", "w3", "w4"]);

  // windowSize=2 drops bm25 rank 3, so "shared" only carries its vector rank.
  const windowed = fuseReciprocalRank(
    [ranking("bm25", bm25), ranking("vector", vector)],
    { windowSize: 2 }
  );
  assert.deepEqual(ids(windowed), ["shared", "w1", "w2", "w3"]);
  const shared = windowed.find((c) => c.chunkId === "shared");
  assert.ok(shared, "shared chunk survives via the vector channel");
  assert.deepEqual(shared.ranks, { vector: 1 });
  approx(shared.score, rrf(DEFAULT_RRF_K, 1));
  assert.ok(
    !("bm25" in shared.ranks),
    "out-of-window bm25 rank is not claimed"
  );
});

test("missing channels: empty and absent channels never disqualify candidates", () => {
  const onlyBm25 = fuseReciprocalRank([ranking("bm25", ["doc-1", "doc-2"])]);
  assert.deepEqual(ids(onlyBm25), ["doc-1", "doc-2"]);
  assert.ok(!("vector" in (onlyBm25[0]?.ranks ?? {})));

  const oneEmpty = fuseReciprocalRank([
    ranking("bm25", ["doc-1"]),
    ranking("vector", []),
  ]);
  assert.deepEqual(ids(oneEmpty), ["doc-1"]);

  assert.deepEqual(
    fuseReciprocalRank([ranking("bm25", []), ranking("vector", [])]),
    []
  );
  assert.deepEqual(fuseReciprocalRank([]), []);
});

test("result metadata explains bm25 rank, vector rank, and fused score", () => {
  const fused = fuseReciprocalRank([
    ranking("bm25", ["doc-1", "doc-2"]),
    ranking("vector", ["doc-2", "doc-3"]),
  ]);

  // doc-2 is the two-channel consensus (0.0325) and outranks both singles.
  assert.deepEqual(ids(fused), ["doc-2", "doc-1", "doc-3"]);
  const [doc2, doc1, doc3] = fused;
  assert.deepEqual(doc2?.ranks, { bm25: 2, vector: 1 });
  assert.deepEqual(doc1?.ranks, { bm25: 1 });
  assert.deepEqual(doc3?.ranks, { vector: 2 });
  approx(doc2?.score ?? 0, rrf(DEFAULT_RRF_K, 2, 1));
  approx(doc1?.score ?? 0, rrf(DEFAULT_RRF_K, 1));
  approx(doc3?.score ?? 0, rrf(DEFAULT_RRF_K, 2));
  assert.ok((doc2?.score ?? 0) > (doc1?.score ?? 0));
});

test("constant and window are configurable", () => {
  const smallK = fuseReciprocalRank([ranking("bm25", ["doc-1"])], { k: 1 });
  approx(smallK[0]?.score ?? 0, 1 / 2);

  const defaultK = fuseReciprocalRank([ranking("bm25", ["doc-1"])]);
  approx(defaultK[0]?.score ?? 0, 1 / (DEFAULT_RRF_K + 1));

  const trimmed = fuseReciprocalRank([ranking("bm25", ["doc-1", "doc-2"])], {
    windowSize: 1,
  });
  assert.deepEqual(ids(trimmed), ["doc-1"]);
});

test("malformed input fails loudly", () => {
  const badK = [0, -5, Number.POSITIVE_INFINITY, Number.NaN];
  for (const k of badK) {
    assert.throws(
      () => fuseReciprocalRank([ranking("bm25", ["doc-1"])], { k }),
      /fusion: k must be a finite number > 0/u
    );
  }
  const badWindows = [0, -1, 2.5];
  for (const windowSize of badWindows) {
    assert.throws(
      () => fuseReciprocalRank([ranking("bm25", ["doc-1"])], { windowSize }),
      /fusion: windowSize must be an integer >= 1/u
    );
  }
  assert.throws(
    () =>
      fuseReciprocalRank([
        ranking("bm25", ["doc-1"]),
        ranking("bm25", ["doc-1"]),
      ]),
    /fusion: duplicate channel "bm25"/u
  );
  assert.throws(
    () => fuseReciprocalRank([ranking("bm25", ["doc-1", "doc-1"])]),
    /fusion: duplicate candidate "doc-1" in channel "bm25"/u
  );
  assert.throws(
    () => fuseReciprocalRank([ranking("", ["doc-1"])]),
    /fusion: channel name must be non-empty/u
  );
});
