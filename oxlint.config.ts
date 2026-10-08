// Ultracite core preset plus the few exceptions below; everything else is
// exactly as Ultracite ships it (error severity, no warnings).
import core from "ultracite/oxlint/core";

export default {
  ...core,
  overrides: [
    ...(core.overrides ?? []),
    {
      // Tests drive state machines step by step, stub node APIs, and keep
      // fixtures shaped like real payloads.
      files: ["**/tests/**"],
      rules: {
        "no-await-in-loop": "off",
        "no-promise-executor-return": "off",
        "no-template-curly-in-string": "off",
        "promise/avoid-new": "off",
        "promise/param-names": "off",
        "promise/prefer-await-to-callbacks": "off",
        "require-await": "off",
        "sort-keys": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      // Sequential-by-design loops (rate limits, leases, ordered upserts) and
      // Promise wrappers around callback-style node:http / node:net.
      files: [
        "apps/factory/collector/*.ts",
        "apps/knowledge/src/embedder.ts",
        "apps/knowledge/src/git-source.ts",
        "apps/knowledge/src/ingest.ts",
        "apps/knowledge/src/schema.ts",
        "apps/knowledge/server/ingest/worker.ts",
        "apps/panel/server/k8s.ts",
        "scripts/egress-smoke.mjs",
      ],
      rules: {
        "no-await-in-loop": "off",
        "promise/avoid-new": "off",
      },
    },
    {
      // FNV-1a hashing is bitwise by definition.
      files: ["apps/knowledge/eval/rank.ts"],
      rules: { "no-bitwise": "off" },
    },
  ],
};
