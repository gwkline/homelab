// Unit tests for the dispatcher Job builder (issue #21). The manifest is
// constructed as a JavaScript object and serialized with JSON.stringify, so
// arbitrary shell in DISPATCH_COMMAND — newlines, quotes, colons, ${...} —
// must survive into the pod env byte-for-byte. No YAML is assembled anywhere.
// Run: node --test examples/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { jobManifest, jobName } from "./dispatch-watcher.mjs";

const envOf = (manifest) =>
  Object.fromEntries(
    manifest.spec.template.spec.containers[0].env.map((e) => [e.name, e.value])
  );

// kubectl consumes the serialized document, so the round-trip through
// JSON.parse(JSON.stringify(...)) is exactly what the pod would receive.
const roundTrip = (manifest) => JSON.parse(JSON.stringify(manifest));

const loopCommandOf = (manifest) => envOf(manifest).LOOP_COMMAND;

const baseOpts = {
  command: "true",
  issueNumber: 21,
  name: "dispatched-issue-21",
  repo: "gwkline/homelab",
};

// Reads the literal block scalar of DISPATCH_COMMAND straight out of
// deploy/dispatcher/base/cronjob.yaml (the documented default the watcher
// runs with) so the test fails if the manifest builder ever drifts from it.
const defaultDispatchCommand = () => {
  const lines = readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "deploy",
      "dispatcher",
      "base",
      "cronjob.yaml"
    ),
    "utf-8"
  ).split("\n");
  const start = lines.findIndex((l) => l.trim() === "- name: DISPATCH_COMMAND");
  assert.ok(start >= 0, "DISPATCH_COMMAND env not found in cronjob.yaml");
  const value = lines.findIndex(
    (l, i) => i > start && i <= start + 2 && l.trim() === "value: |"
  );
  assert.ok(value > 0, "DISPATCH_COMMAND value is not a literal block scalar");
  const indent = lines[value].length - lines[value].trimStart().length;
  const raw = [];
  for (const line of lines.slice(value + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length <= indent) {
      break;
    }
    raw.push(line.slice(indent));
  }
  while (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  // `|` clip semantics: keep a single trailing newline.
  return raw.join("\n") + "\n";
};

test("single-line command round-trips exactly", () => {
  const command = "node /data/repos/homelab/examples/loop-hello.mjs";
  const manifest = roundTrip(jobManifest({ ...baseOpts, command }));
  assert.equal(loopCommandOf(manifest), command);
  assert.equal(manifest.apiVersion, "batch/v1");
  assert.equal(manifest.kind, "Job");
  assert.equal(manifest.metadata.name, baseOpts.name);
  assert.equal(manifest.metadata.namespace, "sandbox");
});

test("multiline, quoted, colon-laden, ${...} and newline commands survive byte-for-byte", () => {
  const commands = [
    // backslash continuation like the default dispatcher command
    "node loop-hello.mjs && \\\n  echo done",
    "echo \"double quotes\" && echo 'single quotes'",
    'echo "key: value" && echo "url: http://example.invalid:8080/p?a=1"',
    'echo "issue ${WATCHER_ISSUE}: all checks passed"',
    "line one\nline two\nline three",
    "trailing newline kept\n",
    "\nleading blank line kept",
    "  leading indentation\n    and deeper  \tindentation\n",
    "heredoc<<'EOF'\n\"quotes\" : colons : ${vars}\nEOF",
  ];
  for (const command of commands) {
    const manifest = roundTrip(jobManifest({ ...baseOpts, command }));
    assert.equal(
      loopCommandOf(manifest),
      command,
      `command did not survive round-trip: ${JSON.stringify(command)}`
    );
  }
});

test("repo and issue values are data, not YAML syntax", () => {
  const repo = 'owner/repo "with junk": and colons';
  const manifest = roundTrip(
    jobManifest({ ...baseOpts, repo, command: "true" })
  );
  const env = envOf(manifest);
  assert.equal(env.WATCHER_REPO, repo);
  assert.equal(env.WATCHER_ISSUE, "21");
  // No manifest text carries YAML artifacts; values are plain fields.
  const serialized = JSON.stringify(manifest);
  assert.ok(!serialized.includes("value: |"));
  assert.ok(serialized.includes(JSON.stringify(repo)));
});

test("default DISPATCH_COMMAND from cronjob.yaml builds a valid Job", () => {
  const command = defaultDispatchCommand();
  // The documented default is multiline shell with a quoted ${...} expansion.
  assert.match(command, /\n/u);
  assert.match(command, /\$\{WATCHER_ISSUE\}/u);
  assert.match(command, /&& \\\n/u);
  const name = jobName("dispatched", 21);
  const manifest = roundTrip(
    jobManifest({ command, issueNumber: 21, name, repo: "gwkline/homelab" })
  );
  assert.equal(loopCommandOf(manifest), command);
  assert.equal(envOf(manifest).WATCHER_ISSUE, "21");
  assert.equal(envOf(manifest).WATCHER_REPO, "gwkline/homelab");
  // Job remains the locked-down shape the manifests promise.
  const [c] = manifest.spec.template.spec.containers;
  assert.equal(c.name, "loop");
  assert.equal(c.securityContext.runAsNonRoot, true);
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(manifest.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(manifest.spec.backoffLimit, 1);
  assert.equal(manifest.spec.ttlSecondsAfterFinished, 604800);
});

test("jobName stays deterministic and dns-1123 safe", () => {
  assert.equal(jobName("dispatched", 42), "dispatched-issue-42");
  assert.equal(jobName("dispatched", 42), jobName("dispatched", 42));
  assert.match(jobName("dispatched", 42), /^dispatched-issue-\d+$/u);
  assert.match(jobName("dispatched", 42), /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u);
  assert.throws(() => jobName("bad prefix!", 1));
  assert.throws(() => jobName("Dispatched", 1));
});
