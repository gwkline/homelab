import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

// Exercise the actual component tree, including Base UI, in the default CI
// suite. Compilation alone cannot catch React render-time adapter failures.
test("dashboard renders an accessible overview without claiming loaded health", async () => {
  const output = path.resolve(
    import.meta.dirname,
    "../dist/dashboard-render-test.mjs"
  );
  await mkdir(path.dirname(output), { recursive: true });
  await build({
    bundle: true,
    entryPoints: [path.resolve(import.meta.dirname, "../web/src/app.tsx")],
    format: "esm",
    jsx: "automatic",
    outfile: output,
    packages: "external",
    platform: "node",
  });
  try {
    const { default: App } = await import(pathToFileURL(output).href);
    const { createElement } = await import("react");
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(createElement(App));
    assert.match(html, /<h1[^>]*>Homelab<\/h1>/u);
    assert.match(html, /aria-label="Main navigation"/u);
    assert.match(html, /aria-pressed="true"[^>]*>[\s\S]*?Overview/u);
    assert.match(html, /Skip to content/u);
    assert.match(html, /Loading cluster/u);
    assert.match(html, /Loading services/u);
    assert.match(html, /Loading workloads/u);
    assert.match(html, /Open factory/u);
    assert.match(html, /Search knowledge/u);
    assert.doesNotMatch(
      html,
      /NaN|0\/0 healthy|No nodes reported|no matching jobs/u
    );
  } finally {
    await rm(output, { force: true });
  }
});
