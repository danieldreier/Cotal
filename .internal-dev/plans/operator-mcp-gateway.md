# Operator MCP gateway

Status: in progress (direct ChatGPT Desktop stdio acceptance)

## Goal

Ship a trusted, multi-identity Cotal MCP gateway that lets ChatGPT Desktop and Codex use local
stdio. A hosted ChatGPT Web connection through Secure MCP Tunnel is a separate optional remote
surface. The gateway must mirror the existing
connector-core tool surface, teach an unfamiliar model how to use Cotal, expose useful read-only
resources, and prove the shipped artifact against a real mesh and real clients.

## Product contract

- `cotal mcp` is supplied by a separately published, self-registering `@cotal-ai/mcp` extension.
- The default transport is stdio, used directly by ChatGPT Desktop, Codex CLI, and the Codex IDE
  extension through their shared MCP configuration. `--space` is explicit in desktop onboarding so
  target selection cannot depend on the host working directory.
- `--transport http` binds a loopback-only `/mcp` endpoint only for the optional, separately
  operated hosted ChatGPT Web/Secure MCP Tunnel route.
- A transport-neutral connector-core factory registers the shared Cotal tools and resources.
- `cotal://context` exposes the structured orientation snapshot as JSON.
- `cotal://inbox` is a forced-peek resource and never acknowledges or drains messages.
- Resource-update notifications are advisory and subscription-scoped. They are not described as
  waking Codex or ChatGPT; active tool calls remain the delivery path.
- One bootstrap authority lazily provisions child Cotal identities. Clients never supply raw
  credentials, owners, ACLs, or lifecycle identifiers.
- Each active identity owns a distinct MeshAgent, broker credential, lifecycle, inbox, and presence.
  An opaque identity handle selects the actor for every call; no side-effecting call guesses when
  more than one identity could apply.
- Child identities may only fit within the bootstrap authority's persona and grant envelope.
- V1 is a private, single-operator gateway. A published multi-user app is out of scope.

## Tool UX

Add `cotal_identity_open`, `cotal_identity_list`, `cotal_identity_use`, and
`cotal_identity_close`. Existing tools accept an optional identity handle in gateway mode while
the existing single-agent connectors retain their current schemas and behavior.

Every result names the acting identity. Errors return stable codes plus `didRun`, `outcome`,
`retryable`, and an exact next-tool suggestion where possible. Descriptions state when to use the
tool, its side effect, identity behavior, important constraints, and the next sensible action.
MCP annotations must accurately distinguish reads, writes, destructive consumption, idempotence,
and open-world effects.

## Architecture

1. Connector-core
   - Add a transport-neutral MCP server factory and resource registration seam.
   - Keep the existing single-agent constructor for Claude/Codex connector compatibility.
   - Add a gateway identity-registry abstraction without importing workspace or command concerns.
2. Workspace
   - Extract connector-neutral target/persona preparation and lifecycle retirement from the
     existing join/spawn provisioning paths.
   - Return resolved material and idempotent cleanup, never connector-core AgentConfig.
3. Operator extension
   - Add `extensions/mcp` / `@cotal-ai/mcp`, with peer dependencies on core, workspace, and
     connector-core.
   - Self-register the `mcp` command and managed local-process surface.
   - Implement stdio and bounded loopback Streamable HTTP adapters.
4. Published-artifact validation
   - Pack the complete first-party closure, install it into an empty npm prefix, add only the
     unpacked extension artifact through the installed CLI, and run open/static real-mesh round trips.
   - Isolate HOME, XDG_CONFIG_HOME, COTAL_HOME, and npm cache so this path cannot inherit an
     operator's Cotal state, credentials, or source checkout.
5. Skill and docs
   - Ship the canonical `cotal-mesh` Agent Skill through both the cross-vendor installer and Codex's
     native `$CODEX_HOME/skills` root, including the Codex interface metadata.
   - Keep skill-discovery proof separate from MCP tool-discovery proof.
   - Document the direct ChatGPT Desktop/Codex stdio setup and keep the optional hosted tunnel flow
     clearly separate.

## Security invariants

- Stdio stdout is JSON-RPC only; diagnostics and readiness go to stderr.
- HTTP rejects non-loopback peers, unexpected Host values, oversized/slow bodies, stale sessions,
  and non-initialize session creation before dispatch. Its documented tunnel control plane, not an
  arbitrary local bearer header, authenticates the remote ChatGPT connection.
- HTTP sessions share the gateway registry but have isolated MCP server/subscription state.
- Session IDs are routing keys, never authentication.
- Session count, request size/time, idle lifetime, and shutdown are bounded.
- Shutdown stops admission, closes MCP sessions, stops every MeshAgent, and retires each lifecycle.
- Inbox resources and repeated reads cannot acknowledge data. Only an explicit non-peek tool call may
  clear exactly the messages it returns.
- Unknown write outcomes are never reported as safe to retry.

## Change series

1. `feat: add shared Cotal MCP server and resources`
2. `feat: add standalone identity provisioning lifecycle`
3. `feat: add trusted multi-identity MCP gateway`
4. `feat: add stdio and loopback HTTP operator transports`
5. `test: prove the packed operator MCP gateway`
6. `feat: ship Cotal mesh skill and client workflows`
7. `feat: guide MCP hosts through Cotal identity setup`

Each branch is based on the preceding reviewed commit, uses its own worktree, contains its focused
tests and docs, and is independently reviewable. The integration branch is updated only by the
coordinator after verification.

## Validation

- Protocol: real SDK clients over stdio child-process and Streamable HTTP transports.
- Mesh: isolated real open and static-auth `nats-server` cases with real peer witnesses.
- Semantics: identity isolation, per-call actor selection, persona/grant narrowing, forced inbox
  peek, lifecycle cleanup, stdout purity, session expiry, and denial ordering.
- Mutation: named mutations for identity selection, non-acking resources, auth-before-parse,
  closed schemas, lifecycle rollback, and shutdown.
- Artifact: pack the full package closure, install into an isolated prefix, and run only installed
  binaries/exports against real open and static-auth meshes. The extension input is unpacked from
  its packed tarball, never a checkout directory. The installed stdio and loopback HTTP command
  compositions both run against real SDK clients and witnesses.
- Codex: isolated CODEX_HOME, `codex mcp add`, real authenticated `codex exec`, then PTY TUI proof.
- Skill: a fresh Codex session must load the installed skill marker without MCP tools configured.
- ChatGPT Desktop: manual authorized standard-stdio acceptance through Settings → MCP servers,
  restart, `/mcp` discovery, orientation, identity creation, real nonce round trips, and no idle
  wake claim. The desktop configuration uses the same Codex MCP config proven by the automated
  Codex acceptance.
- Hosted ChatGPT Web: optional, separate Secure MCP Tunnel acceptance (metadata review/refresh,
  tunnel failure/recovery, and redacted receipts) only if the hosted product is in scope.

### Current live-host receipt

On 2026-08-27 the complete installed-artifact Codex acceptance passed under an isolated profile:
Codex registered the absolute packed gateway command, discovered it during a real authenticated turn,
opened an identity, called orientation and send, and a separate real Cotal witness received the nonce.
The local Codex runtime needs the existing verified system CA bundle supplied as
`SSL_CERT_FILE=/etc/ssl/cert.pem`; this selects normal certificate verification rather than disabling
or altering trust. The test never copies or reads the Codex authentication file.

The separate fresh-host skill proof also passed: a sandboxed `cotal setup` installed `cotal-mesh` into
both local roots with Codex metadata, and an authenticated Codex 0.149.1 session with no MCP
configuration explicitly selected `$cotal-mesh`, read the native installed skill, and returned its
discovery marker. The skill proof uses a disposable home/project and no Cotal connection; it is kept
separate from MCP tool discovery.

The current official `tunnel-client` v0.0.13 was also inspected from its published macOS arm64
release. Its real `init` command accepted the exact Cotal loopback target
`http://127.0.0.1:8811/mcp`, materialized the DCR-capable HTTP profile, and retained the control-plane
key only as `env:CONTROL_PLANE_API_KEY`. This was a disposable, placeholder-ID parser check; no
control-plane credential or tunnel was configured. This affects only the optional hosted Web route,
not direct ChatGPT Desktop stdio.

## Completion audit — 2026-08-27

| Objective requirement | Current direct evidence | Verdict |
| --- | --- | --- |
| Shared Cotal MCP surface mirrors existing connectors | `createCotalMcpServer` registers existing `cotalToolSpecs` plus context/inbox resources; `@cotal-ai/mcp` only supplies identity/session and transport policy. | Proven locally. |
| Trusted multi-identity Cotal access | Gateway provisions from one persona envelope, returns opaque handles, and rejects ambiguous actor selection. Real open and static mesh cells prove separate actors, writes, peeks, and retirement. | Proven locally. |
| Helpful unfamiliar-host flow and skill discovery | Real raw stdio initialize smoke proves JSON-RPC-only stdout and guidance to open an identity, orient, and use `$cotal-mesh` when supported. A fresh authenticated Codex 0.149.1 session loaded the installed native skill without MCP configuration. | Proven locally. |
| Useful live context and message notice without a polling loop | `cotal://context` is typed live orientation; `cotal://inbox` is forced peek. Real SDK subscription smoke receives `notifications/resources/updated` after a witness DM, and repeated reads preserve the message. Notifications are explicitly advisory, not wake/ack authority. | Proven at MCP protocol level; host wake is intentionally not claimed. |
| Real end-to-end MCP driver and shipped artifact | `smoke:mcp-gateway`, `smoke:mcp-http`, and installed tarball open/static cells use real `nats-server`, SDK transports, and witnesses. Credential-gated `smoke:mcp-gateway-codex-live` passed with a real authenticated Codex action through the packed binary. | Proven locally. |
| ChatGPT Desktop can reach the local mesh | ChatGPT Desktop officially supports local stdio MCP and shares Codex MCP configuration; the packed installed stdio command is proven from an unrelated host directory against real open/static meshes, and real Codex registered/discovered/used that same configuration shape. | Direct transport and artifact path proven; a real Desktop UI/tool-call receipt remains to record. |
| Clean review series | Focused local review refs exist for core, provisioning, gateway, HTTP, skill, and full validation; integration is clean at `review/operator-mcp-validation`. | Ready for human review locally. |

The remaining Desktop UI receipt is deliberately not inferred from protocol or Codex tests: it must
show ChatGPT Desktop loading the shared stdio configuration and completing the documented
identity/orientation/nonce round trip. It does not require a tunnel. A tunnel, workspace key, and
Developer Mode conversation are required only for the optional hosted Web route.

## Out of scope

- Public multi-user ChatGPT publication.
- Client-supplied credentials or raw grants.
- A new Cotal wire/SPEC protocol.
- Claiming that MCP resource notifications start or steer model turns.
