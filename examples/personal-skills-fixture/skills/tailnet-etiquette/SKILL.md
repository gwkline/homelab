---
name: tailnet-etiquette
description: Naming and phrasing etiquette for homelab tailnet services in docs, commits, and chat.
---

# Tailnet etiquette

When writing or speaking about homelab services (docs, commit messages, PRs, chat):

- Use the placeholder form `https://<service>.<tailnet>.ts.net` — never write a
  real tailnet hostname from memory. Real suffixes are machine-specific and
  must not be baked into skills, scripts, or docs.
- Prefer service names over addresses ("the panel", not an IP).
- If a service is unreachable, report the service name plus the exact command
  that failed. Never guess a replacement hostname.
