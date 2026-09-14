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
      // Issue collector (#78): polling is deliberately sequential — one
      // bounded stream of GitHub API calls per tick. Fan-out via Promise.all
      // would spike concurrent request bursts against the rate limiter, and
      // per-repo error isolation needs sequential try/catch so one repo's
      // failure never masks another's progress.
      files: ["apps/factory/collector/*.ts"],
      rules: { "no-await-in-loop": "off" },
    },
    {
      // Collector tests (#78): fakes intentionally return values without
      // awaiting (require-await), carry hostile/untrusted fixture strings
      // that look like template placeholders, and reuse the repo's object
      // fixtures verbatim (sort-keys) — all by design.
      files: ["apps/factory/collector/tests/**"],
      rules: {
        "no-template-curly-in-string": "off",
        "promise/prefer-await-to-callbacks": "off",
        "require-await": "off",
        "sort-keys": "off",
      },
    },
  ],
};
