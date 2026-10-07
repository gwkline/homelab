# clusters/home

The root cluster entry point: one Kustomization composing the core set (namespaces, network policies, image policy, secret plumbing, postgres, workloads), listed in dependency order in [base/kustomization.yaml](base/kustomization.yaml).

```sh
kubectl kustomize clusters/home   # render
kubectl apply -k clusters/home    # apply
```

Before the first apply on a fresh cluster: the 1Password service-account Secrets (`scripts/create-onepassword-service-account.sh`), then the server-side/helm operators whose CRDs the core set uses — ESO ([deploy/eso](../../deploy/eso/README.md)), CNPG ([deploy/cnpg](../../deploy/cnpg/README.md)), and policy-controller. Install tailscale-operator ([deploy/tailscale](../../deploy/tailscale/README.md)) after. [docs/rebuild-runbook.md](../../docs/rebuild-runbook.md) has the full sequence.

executor, knowledge, and cloudbeaver are not in the core set; apply them individually from `deploy/`.
