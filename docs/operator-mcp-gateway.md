# Operator MCP gateway

> **Guide** (informative) · **For:** one trusted local operator · **Prereqs:** a running open or static-auth mesh

`@cotal-ai/mcp` is a separately installed Cotal extension that serves the shared Cotal MCP tools either over local stdio or a private loopback HTTP endpoint. It creates fresh, session-scoped Cotal identities on demand. Each opaque handle owns its own broker credential, MeshAgent, inbox, presence, and lifecycle; closing it stops the agent and retires that exact lifecycle.

Install the extension, then point the gateway at the persona that defines the permitted channel and capability envelope:

```bash
cotal ext add @cotal-ai/mcp
cotal mcp --config gateway
```

`--config <persona-or-path>` wins over the older `--persona` alias. The gateway currently supports open and static-auth meshes. It refuses user-auth targets rather than guessing a provisioning path.

## Codex stdio

Configure Codex to run the gateway as a stdio MCP server. Keep the command local and supply only mesh selection and the persona reference; do not put credentials, owners, ACLs, or lifecycle values in the client configuration.

```toml
[mcp_servers.cotal]
command = "cotal"
args = ["mcp", "--config", "gateway"]
```

Start with `cotal_identity_open`. It returns an opaque handle. `cotal_identity_list`, `cotal_identity_use`, and `cotal_identity_close` manage handles. Every usual `cotal_*` tool accepts an optional `identity` handle. With several open identities, calls that omit it fail loudly unless `cotal_identity_use` selected a default. `cotal://context` and `cotal://inbox` read the selected identity; the inbox resource is always a non-consuming peek.

The gateway writes JSON-RPC only to stdout. Its stderr diagnostics are not MCP messages.

`cotal setup` also installs the `cotal-mesh` Agent Skill into Codex's native
`$CODEX_HOME/skills/cotal-mesh` directory (normally `~/.codex/skills/cotal-mesh`). In a Cotal task,
tell a new Codex session to use `$cotal-mesh`; it teaches the model to orient before acting and to
distinguish live MCP state from static guidance. Skill availability does not imply a mesh connection;
the MCP tools remain the source of truth.

For the credential-gated Codex acceptance on a macOS host where the Codex CLI reports
`UnknownIssuer`, use the verified system bundle rather than disabling TLS verification:

```bash
SSL_CERT_FILE=/etc/ssl/cert.pem COTAL_E2E_CODEX=1 pnpm smoke:mcp-gateway-codex-live
```

## ChatGPT Desktop through Secure MCP Tunnel

ChatGPT cannot attach to a local stdio process directly. For the ChatGPT Desktop product, run the separate HTTP transport on an explicit loopback port:

```bash
cotal mcp --transport http --port 8811 --config gateway
```

The process reports `http://127.0.0.1:8811/mcp` on stderr. It accepts only that loopback listener and exact loopback Host headers; it refuses a public/non-loopback bind, unknown sessions, requests larger than 4 MiB, and sessions idle longer than 15 minutes. It is not an Internet-facing server.

Create a private tunnel in OpenAI Platform tunnel settings, then run `tunnel-client` on this same machine or private network. Use `tunnel-client help quickstart`; initialize a named profile with its `tunnel_id` and `--mcp-server-url http://127.0.0.1:8811/mcp`, check it with `tunnel-client doctor --profile <name> --explain`, and leave `tunnel-client run --profile <name>` running. The tunnel client owns its runtime API key and keeps it out of Cotal configuration and logs. Its `/readyz` and `/healthz` endpoints are the operator readiness receipt. The current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) is authoritative for client installation, profile syntax, organization/workspace association, and Developer Mode availability.

In ChatGPT Plugins, create a private Developer Mode draft app, choose **Tunnel**, and select or paste that `tunnel_id`. This v1 connection is for one trusted operator: every ChatGPT conversation reaches the same local Cotal provisioning authority and its independently opened Cotal identities. Do not publish or share it as a multi-user app until Cotal has per-user mesh identity and attribution.

The tunnel is an outbound transport path, not a Cotal credential relay. The local process retains all mesh credentials; ChatGPT never provides an owner, credential, ACL, lifecycle ID, or arbitrary persona grant. The loopback listener and tunnel client are a same-host/same-operator trust boundary. Do not put the listener behind a public reverse proxy or add an undocumented bearer-header convention.

Inbound Cotal traffic is pull-only. A peer message never starts or steers a ChatGPT conversation; inside an active conversation, use `cotal_inbox` (or read `cotal://inbox`) to inspect it. The inbox resource always peeks, and resource notifications are advisory protocol metadata rather than delivery or wake authority.

Before treating a ChatGPT connection as accepted, perform a real operator check in a new conversation: discover the Cotal tools, call `cotal_orientation`, open/select an identity, receive a peer nonce through two repeated inbox peeks, send a second nonce to a real witness, then stop and restart the tunnel client and verify failure/recovery. Save redacted tool/witness and tunnel health receipts. Refresh and review the draft app before expecting a tool-metadata change in a new conversation.
