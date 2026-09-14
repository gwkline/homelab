// oxlint config overrides on top of the Ultracite core preset (#115).
// Everything not listed here is exactly as Ultracite ships it: error severity,
// no warnings. Each override needs a justification comment.
import core from "ultracite/oxlint/core";

export default {
  ...core,
  overrides: [
    ...(core.overrides ?? []),
    {
      // k8sFetch bridges node:http's callback/stream API; a Promise executor
      // is the idiomatic wrapper there, not an anti-pattern.
      files: ["apps/panel/server/k8s.ts"],
      rules: { "promise/avoid-new": "off" },
    },
    {
      // Egress smoke (examples/egress-smoke.mjs): the TCP prober wraps node:net's
      // event API in one Promise, and the checks run sequentially on purpose —
      // deterministic report order, no 13-socket fan-out from a sandbox pod.
      files: ["examples/egress-smoke.mjs"],
      rules: {
        "no-await-in-loop": "off",
        "promise/avoid-new": "off",
      },
    },
    {
      // Tests deliberately exercise raw error paths (unawaited promises,
      // process spin-up) and keep fixture objects shaped like real payloads.
      files: ["apps/panel/tests/**"],
      rules: {
        "no-promise-executor-return": "off",
        "promise/avoid-new": "off",
        "promise/param-names": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      // FNV-1a feature hashing (deterministic eval embeddings, #59) is a
      // bitwise algorithm by definition — the xor/shift path is the hash,
      // not a mistyped boolean. Every other rule in the file complies.
      files: ["apps/knowledge/eval/rank.ts"],
      rules: { "no-bitwise": "off" },
    },
    {
      // Ingest queue tests (#58) drive the state machine step by step —
      // claim, lease, recover — where sequential awaits ARE the behavior
      // under test, and simulate hangs with deliberately unsettled Promise
      // executors. Parallelizing would test a different system.
      files: ["apps/knowledge-ingest/tests/**"],
      rules: {
        "no-await-in-loop": "off",
        "no-promise-executor-return": "off",
        "promise/avoid-new": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      // The ingest worker (#58) processes a claimed batch sequentially on
      // purpose: each job holds a lease, so concurrent handler execution
      // would reorder publishes across documents for zero throughput gain
      // (the parallelism axis is worker count, not in-batch fan-out). The
      // poll loop is inherently sequential for the same reason.
      files: ["apps/knowledge-ingest/server/worker.ts"],
      rules: { "no-await-in-loop": "off" },
    },
    {
      // store.ts (#58) carries the two domain error types
      // (StoreUnavailableError, SourceNotFoundError) next to the IngestStore
      // contract they guard — one file per two-line Error subclass would
      // scatter the contract for no clarity.
      files: ["apps/knowledge-ingest/server/store.ts"],
      rules: { "max-classes-per-file": "off" },
    },
  ],
};
