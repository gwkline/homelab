# clusters/home

The root cluster entry point: one Kustomization composing the core set (namespaces, network policies, image policy, secret plumbing, postgres, workloads), listed in dependency order in [base/kustomization.yaml](base/kustomization.yaml).

```sh
kubectl kustomize clusters/home   # render
kubectl apply -k clusters/home    # apply
```

Before the first apply on a fresh cluster: the server-side/helm operators whose CRDs the core set uses — ESO ([deploy/eso](../../deploy/eso/README.md)) followed by its 1Password token Secret (`scripts/create-onepassword-service-account.sh`), CNPG ([deploy/cnpg](../../deploy/cnpg/README.md)), and policy-controller. Install tailscale-operator ([deploy/tailscale](../../deploy/tailscale/README.md)) after. [docs/rebuild-runbook.md](../../docs/rebuild-runbook.md) has the full sequence.

Outside the core set: knowledge (`deploy/knowledge/base`) and the operator namespaces' NetworkPolicies (`deploy/operator-policies/base`), applied individually. `deploy/executor` is not deployed.

`node/` holds the server's IP, which kustomize writes into the NetworkPolicies that allow the Kubernetes API ([docs/egress-policy.md](../../docs/egress-policy.md)).
