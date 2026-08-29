# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security** tab → "Report a vulnerability". Please do not open a public issue for anything you believe is exploitable.

You can expect a first response within a few days. This is a homelab run by one person; timelines are best-effort.

## Scope

In scope: everything in this repo — bootstrap scripts, container images, Kubernetes manifests, CI workflows.

Out of scope: upstream tools deployed here (t3, hermes-agent, k3s, Tailscale). Report those to their respective projects.

## Design context

The security model and its deliberate tradeoffs are documented in the main README under "Security model". Read it before reporting; several choices (open egress, privileged dind in `sandbox`, Tailscale SSH on nodes) are documented decisions with reasons.
