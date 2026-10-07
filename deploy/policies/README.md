# policies

Namespace-level network policy and, since issue #28, the native admission
policy constraining agent-created Jobs. No extra controllers.

## sandbox-job-guard (ValidatingAdmissionPolicy)

Every `Job` **create** in `sandbox` — regardless of which identity submits it
(panel, factory orchestrator, anything able to create Jobs) — is validated at
admission, inspecting `spec.template.spec` directly, so a hostile PodSpec
cannot hide behind its accepted Job. Identities that can create Jobs in
`sandbox` are therefore not node administrators, even though the namespace's
baseline Pod Security already covers the host-facing controls.

Enforced rules (each with its own rejection message):

- No `hostNetwork`, `hostPID`, `hostIPC`, or container `hostPort`s.
- Privileged containers denied — there is no dind sidecar today, so there is
  no carve-out. If dind ever returns, its exact approved container shape gets
  an explicit exemption condition here, never a PSS level change.
- `allowPrivilegeEscalation: true` denied.
- Images restricted to `ghcr.io/gwkline/homelab/**`.
- ServiceAccount restricted to the approved set (`default`, `factory-worker`,
  `factory-collector`, `factory-orchestrator`, `factory-reviewer`,
  `factory-security`, `factory-reclaimer`, `chaos-monkey`), and
  `automountServiceAccountToken: false` required — a mounted or projected
  ServiceAccount token is denied, so an admitted Job has no Kubernetes
  identity even if it picks the "wrong" account name.
- Volumes restricted to `emptyDir`, `secret`, `configMap`, `projected`,
  `downwardAPI` (no hostPath, PVC/CSI, image, or CSI-ephemeral volumes);
  emptyDir needs a `sizeLimit` of at most 10Gi.
- Secret volume mounts must be `readOnly`.
- Every container needs a memory limit of at most 16Gi; cpu limits, when set,
  cap at 4.

`failurePolicy: Fail`: if the API server cannot evaluate the policy, Job
creation fails closed.

Exemptions (via `matchConditions`, both unreachable for agent ServiceAccounts):

| Requester | Why |
| --- | --- |
| group `system:masters` (operator kubeconfig) | break-glass, below |
| username/group `system:kube-controller-manager` or `system:serviceaccount:kube-system:*` | the CronJob controller materializes Jobs from the operator-managed CronJobs in git (factory, chaos), whose templates may automount tokens |

Agents can only hold ServiceAccount identities, which are never in those
groups, so the exemptions are not reachable from the sandbox.

### Break-glass for operators

Apply the Job with the operator kubeconfig (any context whose user is in
`system:masters`). That bypasses **only** this policy — the namespace's
baseline Pod Security and the image-signature policy still apply. So:

- Anything baseline already forbids (privileged, hostPath, hostPID/hostIPC/
  hostNetwork, hostPorts) still needs an explicit human step:
  `kubectl label ns sandbox pod-security.kubernetes.io/enforce-` — visible in
  the audit log, never callable by an agent — plus its manual revert.
- Any VAP-only constraint (arbitrary ServiceAccount, foreign image, writable
  secret mount, missing ceilings, ServiceAccount tokens) is bypassed by the
  operator context alone.

`scripts/job-policy-test.sh` proves the operator bypass works.

## Verification

```
kubectl apply -f deploy/policies/base/job-admission.yaml
./scripts/job-policy-test.sh
```

The script applies every fixture with `--dry-run=server` (nothing persists),
impersonating an agent identity for the allow/deny assertions and
`system:kube-controller-manager` for the CronJob path; the break-glass check
runs unimpersonated and therefore requires the cluster-admin `system:masters`
context. Fixtures PSS baseline also rejects may be denied by PodSecurity
instead of this policy on production namespaces — both count as rejected.
