// Egress smoke test for sandbox pods (#93): proves the egress allowlist does
// what it claims, both from the pod and from inside a dind inner container
// (docker0 traffic is TESTED here, not assumed to inherit pod policy).
//
// Usage:  node egress-smoke.mjs [--phase pod|dind]
// Exit 0 = every check matched its expectation; 1 = any mismatch.
//
// Positive targets are the documented required destinations
// (docs/egress-policy.md): DNS, GitHub, package registry, model API.
// Negative targets are the ranges the sandbox egress policy refuses:
// Kubernetes API, node/kubelet, link-local metadata, tailnet (CGNAT),
// cluster services in other namespaces, and a LAN address.
//
// Node built-ins only; no npm deps, so it also runs inside a bare
// node:<tag> inner container.

import net from "node:net";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const phase = args.includes("--phase")
  ? args[args.indexOf("--phase") + 1]
  : "pod";
const TIMEOUT_MS = Number(process.env.EGRESS_SMOKE_TIMEOUT_MS || 4000);

// Default gateway = the node-side bridge address (10.42.<node>.1 under k3s
// flannel) — a stand-in for "node CIDR" that a pod can always discover.
function defaultGateway() {
  try {
    const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n");
    for (const line of routes.slice(1)) {
      const f = line.split(/\s+/);
      if (f[1] === "00000000" && f[2] && f[2] !== "00000000") {
        return [6, 4, 2, 0]
          .map((i) => parseInt(f[2].slice(i, i + 2), 16))
          .join(".");
      }
    }
  } catch {
    /* no /proc/net/route (shouldn't happen in a pod) */
  }
  return "10.42.0.1";
}

// A TCP connect attempt. Resolves "open" or rejects with the failure mode.
function tcp(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(TIMEOUT_MS);
    sock.once("connect", () => done("open"));
    sock.once("timeout", () => done("timeout"));
    sock.once("error", (err) => done(err.code || "error"));
  });
}

// "fail" = no connection of any kind got through (refused/timeout/no-route).
function check(spec, result) {
  const pass = spec.expect === "open" ? result === "open" : result !== "open";
  return { ...spec, result, pass };
}

const k8sApi = process.env.KUBERNETES_SERVICE_HOST || "10.43.0.1";
const lanHost = process.env.EGRESS_SMOKE_LAN_TARGET || "192.168.1.1";
const gw = defaultGateway();

const tcpSpecs = [
  // --- positive: documented required destinations -------------------------
  { name: "github.com:443 (git/clone/API)", host: "github.com", port: 443, expect: "open" },
  { name: "raw.githubusercontent.com:443 (raw/codeload)", host: "raw.githubusercontent.com", port: 443, expect: "open" },
  { name: "registry.npmjs.org:443 (package registry)", host: "registry.npmjs.org", port: 443, expect: "open" },
  { name: "api.openrouter.ai:443 (model API)", host: "api.openrouter.ai", port: 443, expect: "open" },
  // --- negative: cluster + private-network targets -------------------------
  { name: "kubernetes API via ClusterIP blocked", host: k8sApi, port: 443, expect: "closed" },
  { name: "kubernetes.default.svc:443 blocked", host: "kubernetes.default.svc", port: 443, expect: "closed" },
  { name: "kubelet on node bridge blocked", host: gw, port: 10250, expect: "closed" },
  { name: "API server node port (gw:6443) blocked", host: gw, port: 6443, expect: "closed" },
  { name: "link-local metadata blocked", host: "169.254.169.254", port: 80, expect: "closed" },
  { name: "tailnet MagicDNS (100.100.100.100) blocked", host: "100.100.100.100", port: 53, expect: "closed" },
  { name: "panel service (agents ns) blocked", host: "panel.agents.svc.cluster.local", port: 443, expect: "closed" },
  { name: "LAN target blocked", host: lanHost, port: 443, expect: "closed" },
];

const results = [];

// 1. DNS through the narrow kube-dns rule (must work).
try {
  await dns.resolve4("github.com");
  results.push({ name: "DNS resolve4 github.com (via kube-dns)", result: "resolved", pass: true });
} catch (err) {
  results.push({ name: "DNS resolve4 github.com (via kube-dns)", result: err.code || "failed", pass: false });
}

// 2. TCP matrix.
for (const spec of tcpSpecs) {
  results.push(check(spec, await tcp(spec.host, spec.port)));
}

// 3. One real HTTPS round-trip — proves DNS + routing + TLS end to end the
//    way a clone/package/model call would.
try {
  const res = await fetch("https://api.github.com/zen", {
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
  });
  results.push({ name: "HTTPS GET api.github.com", result: `HTTP ${res.status}`, pass: res.ok });
} catch (err) {
  results.push({ name: "HTTPS GET api.github.com", result: err.name || "failed", pass: false });
}

const failed = results.filter((r) => !r.pass);
console.log(`[egress-smoke] phase=${phase} gateway=${gw}`);
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}  ->  ${r.result}`);
}
if (phase === "dind") console.log("[egress-smoke] dind inner-container phase complete");
if (failed.length > 0) {
  console.error(`[egress-smoke] ${failed.length} check(s) did not match expectations`);
  process.exit(1);
}
console.log("[egress-smoke] all checks matched expectations");