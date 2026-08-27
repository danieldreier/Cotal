# Operator MCP gateway

> **Guide** (informative) · **For:** one trusted local operator · **Prereqs:** a running open or static-auth mesh

`@cotal-ai/mcp` is a first-party Cotal extension, seeded automatically with the CLI so `cotal mcp` is available after the first command. It serves the shared Cotal MCP tools either over local stdio or a private loopback HTTP endpoint. It creates fresh, session-scoped Cotal identities on demand. Each opaque handle owns its own broker credential, MeshAgent, inbox, presence, and lifecycle; closing it stops the agent and retires that exact lifecycle.

Point the gateway at the persona that defines the permitted channel and capability envelope:

```bash
cotal mcp --space my-cotal-space --config gateway
```

`--config <persona-or-path>` wins over the older `--persona` alias. The gateway currently supports open and static-auth meshes. It refuses user-auth targets rather than guessing a provisioning path.

## ChatGPT Desktop and Codex (local stdio)

ChatGPT Desktop, Codex CLI, and the Codex IDE extension share the same local MCP configuration.
Use the default stdio gateway in any of them; this is the primary path for a person coding with
ChatGPT Desktop. Keep the command local and supply only the mesh selection and persona reference;
do not put credentials, owners, ACLs, or lifecycle values in the client configuration.

```toml
[mcp_servers.cotal]
command = "cotal"
args = ["mcp", "--space", "my-cotal-space", "--config", "gateway"]
```

Replace `my-cotal-space` with the name shown by `cotal meshes`. Naming the space makes the
server independent of the desktop app's working directory. `--config` may instead be an absolute
path to a persona file when the persona is outside that mesh's catalog.

To add this from ChatGPT Desktop: open **Settings → MCP servers**, choose **Add server**, select
**STDIO**, enter `cotal` as the command and `mcp --space my-cotal-space --config gateway` as its
arguments, then save and restart ChatGPT. The Composer's `/mcp` view shows whether the server is
connected. Configuring the same server through Codex writes the shared configuration too.

Start with `cotal_identity_open`. It returns an opaque handle. `cotal_identity_list`, `cotal_identity_use`, and `cotal_identity_close` manage handles. Every usual `cotal_*` tool accepts an optional `identity` handle. With several open identities, calls that omit it fail loudly unless `cotal_identity_use` selected a default. `cotal://context` and `cotal://inbox` read the selected identity; the inbox resource is always a non-consuming peek.

The MCP `initialize` response gives the same first-call workflow to an unfamiliar host: open an
identity, orient from live state, then use the returned handle. If the host supports Agent Skills,
it also points it at `$cotal-mesh`; the skill is guidance, while the live MCP results remain the
authority.

The gateway writes JSON-RPC only to stdout. Its stderr diagnostics are not MCP messages.

`cotal setup` also installs the `cotal-mesh` Agent Skill into Codex's native
`$CODEX_HOME/skills/cotal-mesh` directory (normally `~/.codex/skills/cotal-mesh`). In a Cotal task,
tell a new Codex session to use `$cotal-mesh`; it teaches the model to orient before acting and to
distinguish live MCP state from static guidance. Skill availability does not imply a mesh connection;
the MCP tools remain the source of truth.

## Cotal Mesh Codex plugin

For a local **Codex** client, this repository also ships a `cotal-mesh` plugin. It bundles the same
portable skills (`cotal-mesh`, `team-topology`, and `cotal-engineering`) with a deliberately small
local MCP declaration: `cotal mcp`. The client never receives a mesh credential, owner, grant, or
lifecycle value. The Cotal CLI resolves the operator's selected current mesh and its normal
`default` persona; `cotal setup` creates that persona for a new local mesh.

From a checked-out Cotal release, add the repository-local marketplace and plugin to an isolated or
everyday Codex home:

```bash
codex plugin marketplace add /path/to/Cotal
codex plugin add cotal-mesh@personal
codex plugin list
codex mcp list --json
```

The last command must show a `cotal` stdio server with arguments `mcp`. If the selected mesh or its
default persona is absent, the server fails clearly when Codex starts it; create/select the mesh and
run `cotal setup` rather than placing credentials in the plugin. The plugin is the convenient Codex
bundle; the explicit `mcp_servers.cotal` configuration above remains the supported ChatGPT Desktop
setup until that client has separately been shown to load a local plugin bundle.

For the credential-gated Codex acceptance on a macOS host where the Codex CLI reports
`UnknownIssuer`, use the verified system bundle rather than disabling TLS verification:

```bash
SSL_CERT_FILE=/etc/ssl/cert.pem COTAL_E2E_CODEX=1 pnpm smoke:mcp-gateway-codex-live
```

## Optional hosted ChatGPT / remote access

The local stdio setup above is sufficient for ChatGPT Desktop. The separate HTTP transport is only
for an operator who deliberately wants a hosted ChatGPT Web/plugin connection through Secure MCP
Tunnel. It is not part of normal desktop coding setup. Run it on an explicit loopback port:

```bash
cotal mcp --transport http --port 8811 --space my-cotal-space --config gateway
```

The process reports `http://127.0.0.1:8811/mcp` on stderr. It accepts only that loopback listener and exact loopback Host headers; it refuses a public/non-loopback bind, unknown sessions, requests larger than 4 MiB, and sessions idle longer than 15 minutes. It is not an Internet-facing server.

Create a private tunnel in OpenAI Platform tunnel settings, then run `tunnel-client` on this same machine or private network. Use `tunnel-client help quickstart`; initialize a named profile with its `tunnel_id` and `--mcp-server-url http://127.0.0.1:8811/mcp`, check it with `tunnel-client doctor --profile <name> --explain`, and leave `tunnel-client run --profile <name>` running. The tunnel client owns its runtime API key and keeps it out of Cotal configuration and logs. Its `/readyz` and `/healthz` endpoints are the operator readiness receipt. The current [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) is authoritative for client installation, profile syntax, organization/workspace association, and Developer Mode availability.

In ChatGPT Plugins, create a private Developer Mode draft app, choose **Tunnel**, and select or paste that `tunnel_id`. This remote v1 connection is for one trusted operator: every ChatGPT conversation reaches the same local Cotal provisioning authority and its independently opened Cotal identities. Do not publish or share it as a multi-user app until Cotal has per-user mesh identity and attribution.

The tunnel is an outbound transport path, not a Cotal credential relay. The local process retains all mesh credentials; ChatGPT never provides an owner, credential, ACL, lifecycle ID, or arbitrary persona grant. The loopback listener and tunnel client are a same-host/same-operator trust boundary. Do not put the listener behind a public reverse proxy or add an undocumented bearer-header convention.

Inbound Cotal traffic is pull-only. A peer message never starts or steers a ChatGPT conversation; inside an active conversation, use `cotal_inbox` (or read `cotal://inbox`) to inspect it. The inbox resource always peeks, and resource notifications are advisory protocol metadata rather than delivery or wake authority.

Before treating the **desktop** connection as accepted, open a new ChatGPT Desktop conversation, check `/mcp`, call `cotal_identity_open` and `cotal_orientation`, receive a peer nonce through two repeated inbox peeks, and send a second nonce to a real witness. Save redacted tool and witness receipts. A peer message while no conversation is active must not start a turn.

For the optional **hosted** connection, perform the same check and also stop/restart the tunnel client to verify clear failure and recovery. Refresh and review the draft app before expecting a tool-metadata change in a new conversation.
