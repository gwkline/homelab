// Minimal example loop target. Replace with real tasks in your own repos.
// Contract for any loop script:
//   1. Do the work (browser, HTTP, whatever — image has Chromium + node).
//   2. Export results before exiting (write a file, POST, git push).
//   3. Exit non-zero on failure so Kubernetes backoff/retries kick in.

import { chromium } from "playwright";

const report = { startedAt: new Date().toISOString(), checks: [] };

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const title = await page.title();
  report.checks.push({ name: "example.com loads", pass: title.length > 0, title });
} finally {
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
// Real loops would push/POST this report here.
if (report.checks.some((c) => !c.pass)) process.exit(1);
