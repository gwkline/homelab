# Sandbox Jobs admission policy (issue #28)

Native admission — a `ValidatingAdmissionPolicy` with CEL expressions plus a
single `ValidatingAdmissionBinding` — that constrains every Job (and CronJob
template) created or updated in the `sandbox` namespace. No new controller,
no CRD, no webhook pod: the k3s API server compiles and evaluates the rules
in-process (CEL admission is GA since Kubernetes 1.30; this cluster runs
k3s v1.36.4+k3s1).

## Why

Pod Security Admission must keep `sandbox` at the `privileged` level because
the loop-agent dind sidecar needs privilege. That makes any identity holding
Job-create RBAC (dispatcher, panel via `loop-manager`, factory-orchestrator)
an implicit node administrator: it could submit a Job with `hostPath`,
`hostPID`, `hostNetwork`, a stolen ServiceAccount, or an extra privileged
container. This policy narrows what a Job in `sandbox` may look like to
exactly the shapes this repo ships — regardless of who submits it.

Job admission inspects `spec.template.spec` (and `spec.jobTemplate.spec.
template.spec` for CronJobs), so the policy cannot be bypassed by creating a
Job directly or hiding a bad PodSpec inside a CronJob template. PSA on Pods
alone is not sufficient for the same reason.

## The contract

| Rule | Constraint |
| --- | --- |
| Host access | No `hostNetwork`, `hostPID`, `hostIPC`, `hostPort`, or `hostPath` |
| ServiceAccounts | `serviceAccountName` must be one of `default`, `dispatcher`, `factory-collector`, `factory-orchestrator`, `factory-reclaimer`, `factory-reconciler`, `factory-reviewer`, `factory-security`, `factory-worker` |
| SA tokens | `automountServiceAccountToken: true` only for the three control pods that need the API: `dispatcher`, `factory-orchestrator`, `factory-reconciler`; everything else must set it `false` |
| Privilege | `privileged: true` only for the exact dind shape: container named `dind`, image `docker:27-dind@sha256:aa3df78e…`, command `["dockerd", "--host=unix:///var/run/docker.sock"]`, no args |
| Privilege escalation | `allowPrivilegeEscalation: true` and non-empty `capabilities.add` denied for every container (including init containers) |
| Images | Only `ghcr.io/gwkline/homelab/*` plus the two pinned `docker:27-cli` / `docker:27-dind` digests |
| Volumes | Only `emptyDir`, `secret`, `configMap`, `projected`, `downwardAPI` (no PVCs, CSI, or network storage); secret-ish mounts must be `readOnly: true`; `emptyDir.sizeLimit` ≤ 20Gi |
| Resources | Every container needs a memory `limits.memory` ≤ 12Gi; a cpu limit, when set, ≤ 2 |

The ceilings encode today's maximum approved workload (12Gi = factory
code-pr worker, 20Gi = dind storage, cpu 2 = worker jobs). Raising a ceiling
is a reviewed diff to `base/jobs-policy.yaml`, not an API call. Digest
pinning of the rolling factory images remains the image-policy layer's job
(ADR-004) — the prefix rule here blocks foreign registries and images.

`failurePolicy: Fail`: if the policy itself errors, requests are denied —
a broken policy can never silently fail open.

## Break-glass (operator-only)

For rare operator workloads that legitimately need more (e.g. debugging with
node access), label the Job:

```yaml
metadata:
  labels:
    sandbox.gwkline.io/break-glass: "true"
```

The label skips every constraint above **only** when the requester is a
cluster operator (the policy checks `request.userInfo.groups` for
`system:masters` — the k3s default kubeconfig credential). Agent identities
hold `loop-manager`-style RBAC and can never reach that skip: they may set
the label, but admission rejects the Job with:

``admission policy "sandbox-jobs-hardening" denied the request: the
sandbox.gwkline.io/break-glass label may only be used by cluster operators…``

Break-glass is for one-shot operator `kubectl apply` Jobs. CronJob templates
should not carry the label (CronJob-controller-created Jobs are not
submitted by an operator credential, so their Jobs would be denied).

## Testing

`scripts/tests/sandbox-policy.test.sh` (CI job `sandbox-policy`, throwaway
k3s at the bootstrap-pinned version) server-side applies the fixtures in
`fixtures/`:

- `allowed/` — mirrors of the real loop-agent/dind Job, dispatched Job,
  factory worker Job, and a factory-orchestrator CronJob — must be admitted
  when applied impersonating the dispatcher ServiceAccount.
- `denied/` — hostPath, hostPID, hostNetwork+hostPort, foreign
  ServiceAccount, token automount, non-dind privileged, dind shape drift,
  foreign image, writable secret mount, PVC, resource blowout, capability
  add — each must be rejected, and the rejection message must contain the
  fragment declared in the fixture's `# expect-deny:` header.
- `break-glass.yaml` — denied as an agent, admitted as cluster-admin.

```sh
sh scripts/tests/sandbox-policy.test.sh              # applies the policy too
SKIP_POLICY_APPLY=1 sh scripts/tests/sandbox-policy.test.sh   # policy already applied
```

## Deploying

```sh
kubectl apply -k deploy/sandbox-policy/base
```

Already part of the rebuild runbook (§8). The policy is cluster-scoped but
the binding restricts evaluation to Jobs/CronJobs in the namespace labelled
`kubernetes.io/metadata.name=sandbox` — `agents` and every other namespace
are untouched.

## Factory coordination

The factory run profiles (ADR-001) already satisfy this contract
(`factory-worker` SA, digest-pinned worker images, cpu 2 / memory 12Gi,
no volumes). When run profiles gain their own workload-contract enforcement,
both layers must keep enforcing the same values — the ceilings in
`base/jobs-policy.yaml` are the source of truth until then.
