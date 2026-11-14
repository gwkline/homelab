#!/bin/sh
# Retirement must remove the workload and its callers, not just its tile.
# This runs offline; it never applies to the configured cluster.
set -eu
cd "$(dirname "$0")/../../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

render() {
  kubectl kustomize "$1" > "$work/render.yaml"
  KUBECONFIG=/dev/null kubectl label --local -f "$work/render.yaml" verify=render -o json | jq -s .
}

render clusters/home > "$work/core.json"
jq -e '
  (tojson | contains("homepage") | not) and
  any(.[]; .kind == "Deployment" and .metadata.namespace == "agents" and .metadata.name == "panel") and
  any(.[]; .kind == "Service" and .metadata.namespace == "agents" and .metadata.name == "panel-http") and
  any(.[]; .kind == "Ingress" and .metadata.namespace == "agents" and .metadata.name == "panel"
    and .spec.ingressClassName == "tailscale"
    and .spec.tls[0].hosts == ["panel"]
    and .spec.defaultBackend.service.name == "panel-http"
    and .spec.defaultBackend.service.port.number == 3001) and
  any(.[]; .kind == "NetworkPolicy" and .metadata.name == "allow-tailscale-to-panel"
    and (.spec.ingress | length) == 3
    and .spec.ingress[0].from[0].podSelector.matchLabels["tailscale.com/parent-resource"] == "panel"
    and .spec.ingress[0].ports[0].port == 3001
    and .spec.ingress[1].from[0].podSelector.matchLabels.app == "factory-stats-snapshot"
    and .spec.ingress[2].from[0].podSelector.matchLabels.app == "executor") and
  any(.[]; .kind == "NetworkPolicy" and .metadata.name == "allow-tailscale-to-t3code"
    and (.spec.ingress | length) == 1
    and .spec.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "tailscale"
    and .spec.ingress[0].ports[0].port == 3773) and
  any(.[]; .kind == "NetworkPolicy" and .metadata.namespace == "work" and .metadata.name == "allow-to-work-t3code"
    and (.spec.ingress | length) == 1
    and .spec.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "tailscale"
    and .spec.ingress[0].ports[0].port == 3773)
' "$work/core.json" > /dev/null

render deploy/executor/base > "$work/executor.json"
jq -e '
  (tojson | contains("homepage") | not) and
  any(.[]; .kind == "StatefulSet" and .metadata.name == "executor"
    and any(.spec.template.spec.containers[].env[];
      .name == "TAILNET_NAME"
      and .valueFrom.configMapKeyRef.name == "tailnet-env"
      and .valueFrom.configMapKeyRef.key == "tailnet-name"
      and .valueFrom.configMapKeyRef.optional == true))
' "$work/executor.json" > /dev/null
printf '%s\n' 'landing-page manifest contract: PASS'
