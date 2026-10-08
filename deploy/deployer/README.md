# deployer

Continuous delivery for this repo's workloads. A CronJob in `agents` runs [deploy.sh](deploy.sh) every 5 minutes on the `ops` image ([images/ops](../../images/ops/Dockerfile)). The script is mounted from the `deployer-script` ConfigMap, which kustomize generates from this directory.

## Each pass

1. **Pick a commit.** Clone `main`. One anonymous GitHub API call (the limit is 60 an hour per source IP) lists the last 100 CI runs on `main`. The deployer deploys the newest of the last 100 first-parent commits that has a successful `ci` run. The log shows the state of HEAD's newest CI run and the commit it deploys. If none of the 100 is green, or the API is unreachable, it applies nothing and the Job fails.
2. **Render.** Run `kubectl kustomize` on each target at that commit, and keep only the kinds the deployer owns (the `targets` list in `deploy.sh`).
3. **Pin images.** Every `ghcr.io/gwkline/homelab/<image>:latest` becomes a digest. The digest comes from the `sha-<short>` tag of the newest green commit, at or before the deployed one, that rebuilt the image. CI rebuilds an image only when its inputs changed since the last green run, so that build has the deployed commit's inputs. `:latest` is never read, because a red run or a re-run can move it.
4. **Dry run.** `kubectl diff --server-side` is the apply run as a server-side dry run, so admission checks every object first. In particular, policy-controller rejects an unsigned digest. Any error stops the pass before anything changes. If nothing differs, nothing is applied.
5. **Apply.** `kubectl apply --server-side --field-manager=deployer --force-conflicts`. Fields the manifests set follow git. Fields they leave out keep their live values. That is why no manifest sets `suspend`: an operator's suspend survives.
6. **Health.** `kubectl rollout status --timeout=150s` runs on every Deployment and StatefulSet in the targets. One that isn't rolled out and ready fails the Job.

## Alerts

A failed pass fails its Job. Failed passes page through the generic Grafana rule `CronJob has not succeeded in two intervals` (`deploy/grafana/base/provisioning/alerting/rules.yaml`), about 20 minutes after the last success, and not while the deployer is suspended. A single failure doesn't page, because the next pass retries 5 minutes later and many failures are transient: an API hiccup, a rollout still going past 150s. The Job log says which step failed.

CI pushes `sha-<short>` before it signs. So a CI run that fails after pushing can leave a green commit's tag on an unsigned image. A scheduled rebuild whose smoke test fails is one example. The dry run then rejects that image and every pass fails until a green run rebuilds it. Re-run the failed run.

## Applied by hand

The deployer writes no RBAC. Writing Roles needs `escalate`/`bind`, which would make it admin of `sandbox`. After merging a change to any of these, a cluster admin applies it:

- **This directory** (the CronJob, the script, the deployer's own RBAC): `kubectl apply -k deploy/deployer`.
- **Roles and RoleBindings in a target base**, such as the factory's:

  ```sh
  sh -c '. deploy/deployer/lib.sh && kubectl kustomize "$1" | select_kinds Role RoleBinding' - deploy/factory/base |
    kubectl apply -f -
  ```

- **Anything else in a target base the deployer doesn't own** (Services, PVCs, ClusterRoles): the base, or `kubectl apply -k clusters/home`. That apply resets homelab images to `:latest` until the next pass pins them again.

## Kill switch

Stop the deployer first, so nothing re-applies mid-incident, then the loops:

```sh
kubectl -n agents patch cronjob deployer -p '{"spec":{"suspend":true}}'
kubectl -n agents delete pod -l app=deployer   # stops a pass already running
for cj in $(kubectl -n sandbox get cronjobs -o name); do
  kubectl -n sandbox patch "$cj" -p '{"spec":{"suspend":true}}'
done
```

Undo with `"suspend":false`. Resume the deployer first, so a fix merged during the incident lands before the loops restart. The deployer never touches `suspend`, so the loops stay suspended across its passes.

## Rollback

Revert the commit on `main`. The deployer rolls back once the revert's CI is green. `kubectl rollout undo` lasts only until the next pass, unless the deployer is suspended.
