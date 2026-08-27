import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  GatewayIdentityRegistry,
  MeshAgent,
  createCotalMcpServer,
  type AgentConfig,
  type CotalMcpSelectedIdentity,
} from "@cotal-ai/connector-core";
import { mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import {
  prepareStandaloneAgent,
  resolveStandaloneAgent,
  type PreparedStandaloneAgent,
  type ResolveFlags,
} from "@cotal-ai/workspace";

/** Arguments shared by the self-registering command and the standalone binary. */
export interface McpGatewayOptions extends ResolveFlags {
  /** Alias of the standalone `config` persona reference. */
  persona?: string;
  config?: string;
}

/** One transport-neutral, session-scoped gateway surface. */
export interface McpGatewayServer {
  server: ReturnType<typeof createCotalMcpServer>;
  space: string;
  /** Stop every selected identity, retire each exact lifecycle, then close MCP resources. */
  close(): Promise<void>;
}

interface LiveIdentity extends CotalMcpSelectedIdentity {
  key: string;
  prepared: PreparedStandaloneAgent;
  resourceListeners?: { incoming: () => void; connection: () => void };
}

const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, "must contain only letters, numbers, dot, underscore, colon, or hyphen");
const handleSchema = z.string().uuid();
const GATEWAY_SESSION_INSTRUCTIONS = [
  "This trusted gateway starts with no Cotal identity selected. First call cotal_identity_open; optionally give it a stable, harmless logical-session key. It returns an opaque handle, never a credential or permission grant.",
  "Then call cotal_orientation (using that handle or cotal_identity_use) before sending, receiving, or managing peers. Its live result is the authority for your identity, channels, capabilities, tools, peers, and unread messages.",
  "If this host supports Agent Skills, invoke $cotal-mesh for workflow guidance. If it does not, these MCP instructions and the tool descriptions are the workflow; do not assume a local skill was loaded.",
  "A cotal://inbox resource update is advisory only: it never starts a user turn or acknowledges a message. During an active, user-directed turn, read cotal://inbox or call cotal_inbox to inspect messages deliberately.",
].join("\n");

function report(code: string, didRun: boolean, outcome: string, retryable: boolean, nextTool: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ code, didRun, outcome, retryable, nextTool, ...extra });
}

function toolResult(text: string, isError = false) {
  const content = [{ type: "text" as const, text }];
  return isError ? { content, isError: true as const } : { content };
}

function configFor(prepared: PreparedStandaloneAgent): AgentConfig {
  return {
    space: prepared.target.space,
    id: prepared.id,
    creds: prepared.creds,
    lifecycleUid: prepared.lifecycleUid,
    name: prepared.name,
    role: prepared.role,
    description: prepared.description,
    tags: prepared.tags,
    meta: { ...(prepared.meta ?? {}), connector: "mcp-gateway" },
    capabilities: prepared.capabilities,
    servers: prepared.target.server,
    subscribe: prepared.subscribe,
    allowSubscribe: prepared.allowSubscribe,
    allowPublish: prepared.allowPublish,
    quiet: prepared.quiet,
    muted: prepared.muted,
    kind: prepared.kind,
    tls: prepared.target.tlsRequired,
  };
}

async function stopIdentity(identity: LiveIdentity): Promise<void> {
  const failures: unknown[] = [];
  if (identity.resourceListeners) {
    identity.agent.off("incoming", identity.resourceListeners.incoming);
    identity.agent.off("connection", identity.resourceListeners.connection);
  }
  await identity.agent.stop().catch((error) => failures.push(error));
  await identity.prepared.retire().catch((error) => failures.push(error));
  if (failures.length) throw new AggregateError(failures, `could not retire gateway identity ${identity.handle}`);
}

/**
 * Create one transport-neutral MCP server for one logical client session. Each
 * transport owns when it connects and closes this surface; identities never
 * cross an MCP session boundary, even when HTTP shares one listener process.
 */
export async function createMcpGatewayServer(options: McpGatewayOptions = {}): Promise<McpGatewayServer> {
  const resolved = resolveStandaloneAgent({
    targetFlags: { space: options.space, server: options.server },
    config: options.config ?? options.persona,
  });
  if (resolved.target.mode === "user")
    throw new Error("cotal mcp: user-auth targets are not supported by this gateway yet; use an open or static-auth mesh");

  const identities = new GatewayIdentityRegistry<LiveIdentity>();
  let resources: ReturnType<typeof createCotalMcpServer>["cotalResources"] | undefined;
  const open = async (key: string) => identities.open(key, async () => {
    const handle = randomUUID();
    // The client controls a harmless session key, never the wire name, grants,
    // owner, credential, or lifecycle.  The prepared persona is the full grant envelope.
    const prepared = await prepareStandaloneAgent({
      resolved,
      name: `${resolved.persona.def.name}-mcp-${handle.slice(0, 8)}`,
    });
    const agent = new MeshAgent(configFor(prepared));
    try {
      await agent.start();
      await agent.waitUntilConnected();
    } catch (error) {
      await agent.stop().catch(() => {});
      await prepared.retire().catch(() => {});
      throw error;
    }
    const identity: LiveIdentity = { handle, key, agent, config: agent.config, prepared };
    // Resource subscriptions are scoped by the shared MCP server.  A gateway
    // child is created after that server, so bridge its real lifecycle events
    // into the same advisory update channel (reads remain authoritative).
    const notify = () => {
      void resources?.notify("cotal://inbox");
      void resources?.notify("cotal://context");
    };
    identity.resourceListeners = { incoming: notify, connection: notify };
    agent.on("incoming", notify);
    agent.on("connection", notify);
    return { handle, key, value: identity, close: () => stopIdentity(identity) };
  });

  // This deliberately never starts or becomes a selectable identity.  The
  // shared factory needs an agent for its static registration shape; all reads
  // and calls go through `selection` and therefore choose a live child only.
  const bootstrap = new MeshAgent({
    ...configFor({
      target: resolved.target, persona: resolved.persona, name: "mcp-gateway-bootstrap", kind: "agent",
      subscribe: resolved.persona.def.subscribe ?? [], allowSubscribe: resolved.persona.def.allowSubscribe ?? resolved.persona.def.subscribe ?? [],
      allowPublish: resolved.persona.def.allowPublish ?? [], id: newIdentity().id, lifecycleUid: mintLifecycleUid(), retire: async () => {},
    }),
  });

  const selection = {
    select(handle?: string): CotalMcpSelectedIdentity {
      return identities.select(handle).value;
    },
  };
  const server = createCotalMcpServer(bootstrap, bootstrap.config, "mcp-gateway", {
    selection,
    additionalInstructions: GATEWAY_SESSION_INSTRUCTIONS,
    registerAdditionalTools(mcp) {
      mcp.registerTool(
        "cotal_identity_open",
        {
          title: "Open Cotal identity",
          description: "Provision and start a fresh least-privilege Cotal identity for this MCP session. Idempotent for the same session key. The client cannot supply credentials, owners, grants, or lifecycle identifiers; next list or use the returned opaque handle.",
          inputSchema: z.strictObject({ key: keySchema.optional() }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ key }) => {
          try {
            const result = await open(key ?? "default");
            return toolResult(report("IDENTITY_OPENED", true, result.created ? "opened" : "already-open", false, "cotal_identity_list", {
              identity: result.identity.handle,
              key: result.identity.key,
              actingIdentity: result.identity.handle,
            }));
          } catch (error) {
            return toolResult(report("IDENTITY_OPEN_FAILED", false, "not-opened", true, "cotal_identity_open", { message: (error as Error).message }), true);
          }
        },
      );
      mcp.registerTool(
        "cotal_identity_list",
        {
          title: "List Cotal identities",
          description: "List the opaque Cotal identity handles currently open in this MCP session. This only reads gateway session state; call identity_use to select a default.",
          inputSchema: z.strictObject({}),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async () => toolResult(report("IDENTITY_LIST", true, "listed", false, "cotal_identity_open", {
          identities: identities.list().map(({ handle, key }) => ({ handle, key })),
        })),
      );
      mcp.registerTool(
        "cotal_identity_use",
        {
          title: "Select default Cotal identity",
          description: "Set this session's default opaque identity handle. Existing Cotal tools use it only when no explicit identity is supplied; with multiple identities an omitted selection otherwise fails loudly.",
          inputSchema: z.strictObject({ identity: handleSchema }),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async ({ identity }) => {
          try {
            const selected = identities.use(identity);
            return toolResult(report("IDENTITY_SELECTED", true, "default-set", false, "cotal_roster", { identity: selected.handle, actingIdentity: selected.handle }));
          } catch (error) {
            return toolResult(report("IDENTITY_NOT_FOUND", false, "not-selected", false, "cotal_identity_list", { message: (error as Error).message }), true);
          }
        },
      );
      mcp.registerTool(
        "cotal_identity_close",
        {
          title: "Close Cotal identity",
          description: "Stop one selected MeshAgent and retire exactly its lifecycle. This is irreversible for that handle; open a new identity to continue.",
          inputSchema: z.strictObject({ identity: handleSchema }),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        async ({ identity }) => {
          try {
            const closed = await identities.close(identity);
            return toolResult(report("IDENTITY_CLOSED", true, "closed", false, "cotal_identity_open", { identity: closed.handle, actingIdentity: closed.handle }));
          } catch (error) {
            return toolResult(report("IDENTITY_CLOSE_FAILED", false, "not-closed", true, "cotal_identity_list", { message: (error as Error).message }), true);
          }
        },
      );
    },
  });
  resources = server.cotalResources;

  let stopping: Promise<void> | undefined;
  const close = (): Promise<void> => (stopping ??= (async () => {
    await identities.closeAll().catch((error) => process.stderr.write(`[cotal-mcp] cleanup: ${(error as Error).message}\n`));
    server.cotalResources.close();
    await server.close().catch(() => {});
  })());
  return { server, space: resolved.target.space, close };
}

/** Run the local stdio product. JSON-RPC remains stdout-only; diagnostics use stderr. */
export async function runMcpGateway(options: McpGatewayOptions = {}): Promise<void> {
  const gateway = await createMcpGatewayServer(options);
  const transport = new StdioServerTransport();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => (stopping ??= (async () => {
    await gateway.close();
    finish();
  })());
  await gateway.server.connect(transport);
  const inheritedClose = transport.onclose;
  transport.onclose = () => { inheritedClose?.(); void shutdown(); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stderr.write(`[cotal-mcp] stdio gateway ready for ${gateway.space}\n`);
  await done;
}
