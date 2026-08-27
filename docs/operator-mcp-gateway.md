# Operator MCP gateway

> **Guide** (informative) · **For:** one trusted local operator · **Prereqs:** a running open or static-auth mesh

`@cotal-ai/mcp` is a separately installed Cotal extension that serves the shared Cotal MCP tools on local stdio. It creates fresh, session-scoped Cotal identities on demand. Each opaque handle owns its own broker credential, MeshAgent, inbox, presence, and lifecycle; closing it stops the agent and retires that exact lifecycle.

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

## ChatGPT

ChatGPT cannot connect to this stdio process directly. The authenticated loopback HTTP endpoint and Secure MCP Tunnel workflow are a later change and are not supported by this release. Do not expose stdio through an ad-hoc network bridge.
