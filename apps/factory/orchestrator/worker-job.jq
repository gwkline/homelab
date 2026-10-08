# Worker Job for one Run, rendered from its RunProfile ConfigMap
# (deploy/factory/base/profile-*.yaml). The profile owns the image, service
# account, resources, priority class, work-volume size and Job lifetime; the
# orchestrator supplies only the run's inputs:
#
#   jq -n --argjson profile <profile.json> --arg job <name> --arg issue <n> \
#     --arg repo <owner/name> --arg brief_b64 <b64> --arg worker_cmd <cmd> \
#     -f worker-job.jq

# Container half of the restricted Pod Security level.
def restricted: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}};

{
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: {
    name: $job,
    namespace: "sandbox",
    labels: {
      "factory.gwkline.io/issue": $issue,
      "factory.gwkline.io/profile": $profile.name
    }
  },
  spec: {
    backoffLimit: $profile.backoffLimit,
    activeDeadlineSeconds: $profile.activeDeadlineSeconds,
    ttlSecondsAfterFinished: $profile.ttlSecondsAfterFinished,
    template: {
      metadata: {labels: {"factory.gwkline.io/profile": $profile.name}},
      spec: {
        restartPolicy: "Never",
        priorityClassName: $profile.priorityClassName,
        serviceAccountName: $profile.serviceAccount,
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: {type: "RuntimeDefault"}
        },
        # The clone runs in its own container, the only one given the GitHub
        # token (ADR-001 D6): the agent reads untrusted text, and anything in
        # its container's env stays readable in /proc/1/environ.
        initContainers: [{
          name: "clone",
          image: $profile.image,
          imagePullPolicy: "Always",
          command: ["/usr/local/bin/prepare"],
          env: [
            {name: "FACTORY_REPO", value: $repo},
            {name: "GH_TOKEN", valueFrom: {secretKeyRef: {name: "github-token", key: "token"}}}
          ],
          resources: {
            requests: {cpu: "100m", memory: "256Mi"},
            limits: {
              cpu: "1",
              memory: "1Gi",
              "ephemeral-storage": $profile.resources.limits["ephemeral-storage"]
            }
          },
          securityContext: restricted,
          volumeMounts: [
            {name: "work", mountPath: "/work"},
            {name: "out", mountPath: "/out"}
          ]
        }],
        containers: [{
          name: "worker",
          image: $profile.image,
          imagePullPolicy: "Always",
          env: [
            {name: "FACTORY_REPO", value: $repo},
            {name: "FACTORY_ISSUE", value: $issue},
            {name: "FACTORY_PROFILE", value: $profile.name},
            {name: "WORKER_CMD", value: $worker_cmd},
            # A file, not env, so the model key stays out of /proc/1/environ.
            {name: "OPENCODE_AUTH_FILE", value: "/secrets/opencode/auth-b64"},
            {name: "FACTORY_BRIEF_B64", value: $brief_b64},
            {name: "FACTORY_SECURITY_MODE", value: "per-issue"}
          ],
          resources: $profile.resources,
          securityContext: restricted,
          volumeMounts: [
            {name: "work", mountPath: "/work"},
            {name: "out", mountPath: "/out"},
            {name: "opencode-auth", mountPath: "/secrets/opencode", readOnly: true}
          ]
        }],
        volumes: [
          {name: "work", emptyDir: {sizeLimit: $profile.workSizeLimit}},
          # Patch, report and skills status only.
          {name: "out", emptyDir: {sizeLimit: "64Mi"}},
          {
            name: "opencode-auth",
            secret: {
              secretName: "factory-opencode-auth",
              optional: true,
              items: [{key: "auth-b64", path: "auth-b64"}]
            }
          }
        ]
      }
    }
  }
}
