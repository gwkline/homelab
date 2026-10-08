# Executor

Self-hosted [Executor](https://github.com/UsefulSoftwareCo/executor) 1.6.7: the MCP/tool gateway shared by t3code, hermes, and laptop clients. One catalog, one credential store, one set of approval policies. It runs as a single process over a SQLite file on the `/data` PVC, which also holds the generated session and credential-encryption keys. Deleting the PVC loses every integration and makes stored credentials undecryptable. It is not backed up.

Not deployed, and not in `clusters/home`. Before it is, move `executor-tailnet` from a Tailscale LoadBalancer Service to an Ingress: the LoadBalancer proxy needs privileged containers, which the `tailscale` namespace rejects ([deploy/tailscale/README.md](../tailscale/README.md#how-exposure-works)).

## Prerequisites

- Optional Secret for a headless admin (otherwise use browser first-run setup):
  ```sh
  kubectl -n agents create secret generic executor-admin \
    --from-literal=email=you@example.com --from-literal=password="$(openssl rand -base64 24)"
  ```
- `homepage-env` key `tailnet-name` must be set. Browser logins are rejected until `EXECUTOR_WEB_BASE_URL` matches the real browser URL; in-cluster MCP works without it.

## Apply

```sh
kubectl apply -k deploy/executor/base
kubectl -n agents rollout status statefulset executor
```

## Endpoints

- Web UI and `/mcp` for laptops: `https://executor.<tailnet>`
- In-cluster MCP: `http://executor.agents.svc:8080/mcp`

Clients authenticate with an API key minted in the web console. Register t3code with `kubectl -n agents exec t3code-0 -- npx add-mcp http://executor.agents.svc:8080/mcp --transport http --name executor`. hermes and t3code read their client token from Secret `executor-client`.

## Factory integration

The panel serves the factory API (`factory-openapi.json`). hermes' and t3code's egress allowlists reach Executor but not the panel, so agents can't get around the approval policies. One-time setup in the web console:

1. Import `deploy/executor/factory-openapi.json` as an OpenAPI integration named `factory`, keeping the default base URL (`http://panel-http.agents.svc:3000`).
2. Create one connection per client (`hermes`, `t3code`), each with its own bearer token from the `tokens` field of 1Password item `panel-auth` (`<client-id>=<token>`). The panel records that client id as "requested by" and refuses mutations without a valid token.
3. Set the policies:

| Tool | Policy |
| --- | --- |
| `factory_list_profiles`, `factory_get_run`, `factory_list_runs` | allow |
| `factory_create_run`, `factory_cancel_run`, `factory_retry_run` | require approval |

For any other integration, allow read tools and set write/delete tools to require approval before sharing the endpoint. Integration credentials stay host-side and never enter the sandbox, the agent, or the logs.

## Notes

- Egress allows public 443 only, plus DNS and the panel. No FQDN filtering.
- Audit identity is per API key, not per MCP session.
