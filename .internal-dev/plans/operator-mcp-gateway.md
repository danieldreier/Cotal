# Operator MCP gateway

Status: planned

## Goal

Ship a trusted, multi-identity Cotal MCP gateway that lets Codex use local stdio and lets
ChatGPT reach the same gateway through Secure MCP Tunnel. The gateway must mirror the existing
connector-core tool surface, teach an unfamiliar model how to use Cotal, expose useful read-only
resources, and prove the shipped artifact against a real mesh and real clients.

## Product contract

- `cotal mcp` is supplied by a separately published, self-registering `@cotal-ai/mcp` extension.
- The default transport is stdio. `--http` binds an authenticated loopback-only `/mcp` endpoint
  for a separately operated OpenAI `tunnel-client`.
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
   - Implement stdio and bounded authenticated loopback Streamable HTTP adapters.
4. Skill and docs
   - Ship the canonical `cotal-mesh` Agent Skill through the existing cross-vendor skill installer.
   - Keep skill-discovery proof separate from MCP tool-discovery proof.
   - Document the short Codex setup and the explicit Secure MCP Tunnel + ChatGPT Developer Mode flow.

## Security invariants

- Stdio stdout is JSON-RPC only; diagnostics and readiness go to stderr.
- HTTP rejects non-loopback peers, unexpected Host values, missing/invalid bearer material,
  oversized/slow bodies, stale sessions, and non-initialize session creation before dispatch.
- Bearer values come from mode-checked private files, never argv, URLs, logs, or tool results.
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
5. `docs: add Cotal mesh skill and client workflows`

Each branch is based on the preceding reviewed commit, uses its own worktree, contains its focused
tests and docs, and is independently reviewable. The integration branch is updated only by the
coordinator after verification.

## Validation

- Protocol: real SDK clients over in-memory, stdio child-process, and Streamable HTTP transports.
- Mesh: isolated real open and static-auth `nats-server` cases with real peer witnesses.
- Semantics: identity isolation, per-call actor selection, persona/grant narrowing, forced inbox
  peek, lifecycle cleanup, stdout purity, session expiry, and denial ordering.
- Mutation: named mutations for identity selection, non-acking resources, auth-before-parse,
  closed schemas, lifecycle rollback, and shutdown.
- Artifact: pack the full package closure, install into an isolated prefix, and run only installed
  binaries/exports against a real mesh.
- Codex: isolated CODEX_HOME, `codex mcp add`, real authenticated `codex exec`, then PTY TUI proof.
- Skill: a fresh Codex session must load the installed skill marker without MCP tools configured.
- ChatGPT: manual authorized Developer Mode acceptance through Secure MCP Tunnel, including metadata
  review/refresh, orientation, identity creation, real nonce round trips, no idle wake claim, tunnel
  failure/recovery, and redacted receipts.

## Out of scope

- Public multi-user ChatGPT publication.
- Client-supplied credentials or raw grants.
- A new Cotal wire/SPEC protocol.
- Claiming that MCP resource notifications start or steer model turns.
