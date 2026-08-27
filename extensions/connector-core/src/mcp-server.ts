/**
 * The transport-neutral MCP surface for one Cotal identity.
 *
 * This module deliberately knows nothing about stdio, HTTP, or identity
 * selection. A transport creates one server for one MeshAgent and owns the
 * transport lifecycle; this module only registers tools/resources and keeps
 * resource subscriptions scoped to that server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { MeshAgent } from "./agent.js";
import { type AgentConfig } from "./config.js";
import { cotalToolSpecs } from "./tool-specs.js";
import { buildOrientation, MESH_FIRST_STEER, ORIENTATION_BOOTSTRAP } from "./orientation.js";
import { registerCotalTools, type CotalMcpToolSelection } from "./tools.js";

export const COTAL_CONTEXT_URI = "cotal://context";
export const COTAL_INBOX_URI = "cotal://inbox";

const RESOURCE_URIS = new Set([COTAL_CONTEXT_URI, COTAL_INBOX_URI]);

/** Resource-side operations returned by {@link registerCotalResources}. */
export interface CotalResourceRegistration {
  /** Notify subscribers that one of the registered resources may have changed. */
  notify(uri: string): Promise<void>;
  /** Detach agent listeners and discard subscription state. */
  close(): void;
}

/** Optional host-owned actor selection.  This keeps the shared server transport
 * neutral while allowing a trusted gateway to choose a different MeshAgent for
 * each request. */
export interface CotalMcpServerOptions {
  selection?: CotalMcpToolSelection;
  /** Register host-specific tools after the common Cotal surface is installed. */
  registerAdditionalTools?: (server: McpServer) => void;
}

/** Notify one server's subscribers without requiring a transport-specific API. */
export async function notifyCotalResourceUpdated(
  registration: CotalResourceRegistration,
  uri: string,
): Promise<void> {
  await registration.notify(uri);
}

function resourceUri(uri: URL): string {
  return uri.href;
}

function resourceContents(uri: URL, mimeType: string, text: string): ReadResourceResult {
  return { contents: [{ uri: resourceUri(uri), mimeType, text }] };
}

/**
 * Register the read-only context/inbox resources and exact subscription
 * handlers. Subscriptions are local to this MCP server instance, which is
 * important when a transport creates one server per session.
 */
export function registerCotalResources(
  server: McpServer,
  agent: MeshAgent,
  config: AgentConfig,
  source = "connector",
  selection?: CotalMcpToolSelection,
): CotalResourceRegistration {
  const subscriptions = new Set<string>();
  let closed = false;

  const notify = async (uri: string): Promise<void> => {
    if (closed || !RESOURCE_URIS.has(uri) || !subscriptions.has(uri) || !server.isConnected()) return;
    try {
      await server.server.sendResourceUpdated({ uri });
    } catch {
      // A transport can close between the connected check and send. Resource
      // notifications are advisory; the next read is authoritative.
    }
  };

  const visibleTools = cotalToolSpecs(config, source).map((spec) => ({
    name: spec.name,
    title: spec.title,
  }));

  server.registerResource(
    "cotal_context",
    COTAL_CONTEXT_URI,
    {
      title: "Cotal context",
      description: "The current structured orientation snapshot for this Cotal identity.",
      mimeType: "application/json",
      annotations: { audience: ["user"], priority: 0.8 },
    },
    async (uri) => {
      const selected = selection ? await selection.select() : { agent, config };
      return resourceContents(
        uri,
        "application/json",
        JSON.stringify(buildOrientation(selected.agent, selected.config, visibleTools, Date.now())),
      );
    },
  );

  const inboxSpec = cotalToolSpecs(config, source).find((spec) => spec.name === "cotal_inbox");
  if (!inboxSpec) throw new Error("cotal_inbox is missing from the Cotal tool surface");
  server.registerResource(
    "cotal_inbox",
    COTAL_INBOX_URI,
    {
      title: "Cotal inbox (peek)",
      description: "Incoming Cotal messages read without acknowledging or draining them.",
      mimeType: "text/plain",
      annotations: { audience: ["user"], priority: 0.9 },
    },
    async (uri) => {
      const selected = selection ? await selection.select() : { agent, config };
      const selectedInbox = selection
        ? cotalToolSpecs(selected.config, source).find((spec) => spec.name === "cotal_inbox")
        : inboxSpec;
      if (!selectedInbox) throw new Error("cotal_inbox is missing from the selected Cotal tool surface");
      return resourceContents(uri, "text/plain", (await selectedInbox.run(selected.agent, selected.config, { peek: true })).text);
    },
  );

  // McpServer 1.29 exposes resource registration but not the two optional
  // subscription handlers. Install them on the underlying Server before a
  // transport connects; capability registration is likewise pre-connect.
  server.server.registerCapabilities({ resources: { listChanged: true, subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!RESOURCE_URIS.has(uri)) {
      throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} does not support subscriptions`);
    }
    subscriptions.add(uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!RESOURCE_URIS.has(uri)) {
      throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} does not support subscriptions`);
    }
    subscriptions.delete(uri);
    return {};
  });

  const onIncoming = (): void => {
    void notify(COTAL_INBOX_URI);
    void notify(COTAL_CONTEXT_URI);
  };
  const onWake = (): void => {
    void notify(COTAL_INBOX_URI);
    void notify(COTAL_CONTEXT_URI);
  };
  const onConnection = (): void => { void notify(COTAL_CONTEXT_URI); };
  const onRoster = (): void => { void notify(COTAL_CONTEXT_URI); };
  agent.on("incoming", onIncoming);
  agent.on("wake", onWake);
  agent.on("connection", onConnection);
  agent.ep.on("roster", onRoster);

  const close = (): void => {
    if (closed) return;
    closed = true;
    subscriptions.clear();
    agent.off("incoming", onIncoming);
    agent.off("wake", onWake);
    agent.off("connection", onConnection);
    agent.ep.off("roster", onRoster);
  };

  return { notify, close };
}

/** Create one transport-neutral MCP server for exactly one MeshAgent. */
export function createCotalMcpServer(
  agent: MeshAgent,
  config: AgentConfig,
  source = "connector",
  options: CotalMcpServerOptions = {},
): McpServer & { cotalResources: CotalResourceRegistration } {
  const server = new McpServer(
    { name: "cotal", version: "0.0.0" },
    { instructions: `${ORIENTATION_BOOTSTRAP}\n\n${MESH_FIRST_STEER}` },
  );
  registerCotalTools(server, agent, config, source, options.selection);
  const resources = registerCotalResources(server, agent, config, source, options.selection);
  options.registerAdditionalTools?.(server);
  return Object.assign(server, { cotalResources: resources });
}
