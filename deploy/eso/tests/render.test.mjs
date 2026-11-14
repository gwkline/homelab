import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, "utf-8");
const parse = (text) => YAML.parseAllDocuments(text).map((doc) => doc.toJSON());
const documents = parse(read("deploy/eso/base/eso.yaml"));
const values = YAML.parse(read("deploy/eso/values.yaml"));
const store = YAML.parse(read("deploy/github-tokens/base/secretstore.yaml"));
const image =
  "ghcr.io/external-secrets/external-secrets:v2.15.0@sha256:6888f243e5f8f7592c6d7fae2a5547c9e33531441b47b53807b9093b25a00e31";
const context = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  runAsUser: 1000,
  seccompProfile: { type: "RuntimeDefault" },
};
const deployments = documents.filter((doc) => doc.kind === "Deployment");
const canonical = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
};

test("three pinned controllers retain security contexts and chart resource bounds", () => {
  assert.equal(documents.length, 44);
  assert.equal(deployments.length, 3);
  for (const doc of deployments) {
    assert.equal(doc.metadata.namespace, "external-secrets");
    const pod = doc.spec.template.spec;
    assert.equal(pod.securityContext, undefined);
    assert.equal(pod.hostNetwork, false);
    assert.equal(pod.automountServiceAccountToken, true);
    assert.equal(pod.containers.length, 1);
    const [container] = pod.containers;
    assert.equal(container.image, image);
    assert.deepEqual(container.securityContext, context);
    const main = doc.metadata.name === "external-secrets";
    assert.deepEqual(container.resources, {
      requests: { cpu: "10m", memory: main ? "64Mi" : "32Mi" },
      limits: { cpu: main ? "500m" : "200m", memory: main ? "256Mi" : "128Mi" },
    });
  }
});

test("RBAC rules, bindings, and scope match the previous reviewed bundle", () => {
  const kinds = new Set([
    "Role",
    "ClusterRole",
    "RoleBinding",
    "ClusterRoleBinding",
  ]);
  const rbac = documents
    .filter((doc) => kinds.has(doc.kind))
    .map((doc) => {
      const copy = structuredClone(doc);
      delete copy.metadata.labels["helm.sh/chart"];
      delete copy.metadata.labels["app.kubernetes.io/version"];
      return copy;
    });
  assert.equal(rbac.length, 9);
  // Includes complete rules, roleRefs, subjects and namespaces; only chart labels vary.
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(canonical(rbac)))
      .digest("hex"),
    "e51e667d81478aaffeec78419609d87e228f14b758e331180396a7dd2ea5018a"
  );
  assert.equal(values.scopedRBAC, false);
  assert.equal(values.scopedNamespace, "");
  assert.equal(values["bitwarden-sdk-server"].enabled, false);
  assert.equal(values.genericTargets.enabled, false);
  assert.equal(values.vault.enableTokenCache, false);
});

test("bounded SDK cache conforms to served CRD without widening authority", () => {
  assert.deepEqual(store.spec.provider.onepasswordSDK, {
    vault: "homelab",
    cache: { ttl: "5m", maxSize: 128 },
    auth: {
      serviceAccountSecretRef: {
        namespace: "external-secrets",
        name: "onepassword-service-account",
        key: "token",
      },
    },
  });
  assert.deepEqual(store.spec.conditions, [
    { namespaces: ["agents", "database", "sandbox", "tailscale", "work"] },
  ]);
  for (const name of ["clustersecretstores", "secretstores"]) {
    const crd = documents.find(
      (doc) =>
        doc.kind === "CustomResourceDefinition" &&
        doc.metadata.name === `${name}.external-secrets.io`
    );
    const version = crd.spec.versions.find(
      (entry) => entry.name === store.apiVersion.split("/")[1]
    );
    assert.equal(version.served, true);
    const schema =
      version.schema.openAPIV3Schema.properties.spec.properties.provider
        .properties.onepasswordSDK.properties.cache;
    assert.equal(schema.type, "object");
    assert.equal(schema.properties.ttl.type, "string");
    assert.equal(schema.properties.maxSize.type, "integer");
    assert.ok(
      store.spec.provider.onepasswordSDK.cache.maxSize >=
        schema.properties.maxSize.minimum
    );
  }
});

test("kustomize retains effective memory bounds and platform priority", () => {
  const effective = parse(
    execFileSync("kubectl", ["kustomize", `${root}deploy/eso/base`], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    })
  );
  const controllers = effective.filter((doc) => doc.kind === "Deployment");
  assert.equal(controllers.length, 3);
  for (const doc of controllers) {
    const pod = doc.spec.template.spec;
    assert.equal(pod.priorityClassName, "homelab-platform");
    assert.deepEqual(pod.containers[0].securityContext, context);
    if (doc.metadata.name === "external-secrets") {
      assert.equal(pod.containers[0].resources.requests.memory, "128Mi");
      assert.equal(pod.containers[0].resources.limits.memory, "768Mi");
    }
  }
});

test(
  "exact chart archive renders deterministically and matches checked-in YAML",
  {
    skip:
      !process.env.ESO_CHART_ARCHIVE &&
      "set ESO_CHART_ARCHIVE to the verified 2.15.0 archive",
  },
  () => {
    const args = [
      "template",
      "external-secrets",
      process.env.ESO_CHART_ARCHIVE,
      "--namespace",
      "external-secrets",
      "--kube-version",
      "1.34.0",
      "--include-crds",
      "--values",
      `${root}deploy/eso/values.yaml`,
    ];
    const render = () =>
      execFileSync("helm", args, {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
    const first = render();
    assert.equal(render(), first);
    assert.deepEqual(parse(first), documents);
  }
);
