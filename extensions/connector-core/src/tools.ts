/**
 * MCP renderer for the Cotal tool surface.
 *
 * The tools themselves are defined once, platform-neutrally, in {@link cotalToolSpecs}
 * ({@link ./tool-specs.ts}); this just renders each onto an {@link McpServer}. The
 * Claude Code connector builds its own server (with platform-specific capabilities) and
 * calls {@link registerCotalTools}. The OpenCode connector renders the same specs as
 * native plugin tools — so the surface stays identical across adapters.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cotalToolSpecs, type ToolResult } from "./tool-specs.js";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";

/** An identity selected by a multi-identity MCP host.  Connector-core deliberately
 * owns only this narrow seam: provisioning and session policy belong to the host. */
export interface CotalMcpSelectedIdentity {
  handle: string;
  agent: MeshAgent;
  config: AgentConfig;
}

export interface CotalMcpToolSelection {
  /** Resolve the explicit handle, or the session default when it is omitted. */
  select(handle?: string): Promise<CotalMcpSelectedIdentity> | CotalMcpSelectedIdentity;
}

function toContent(r: ToolResult) {
  const content = [{ type: "text" as const, text: r.text }];
  return r.isError ? { content, isError: true as const } : { content };
}

function selectedIdentityError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.startsWith("IDENTITY_NOT_FOUND") ? "IDENTITY_NOT_FOUND" : "IDENTITY_REQUIRED";
  const nextTool = code === "IDENTITY_NOT_FOUND" ? "cotal_identity_list" : "cotal_identity_open";
  return toContent({
    text: JSON.stringify({ code, didRun: false, outcome: "identity-selection-failed", retryable: false, nextTool, message }),
    isError: true,
  });
}

/** Register the Cotal tool surface (roster, inbox, send, dm, anycast, status, channels,
 *  channel_info, join, leave, spawn, feedback) on an MCP server. `source` names the
 *  hosting connector for outgoing feedback. */
export function registerCotalTools(
  server: McpServer,
  agent: MeshAgent,
  config: AgentConfig,
  source?: string,
  selection?: CotalMcpToolSelection,
): void {
  // No schemaless branch. Registering a tool WITHOUT an `inputSchema` is what let a no-argument
  // tool accept `{owner, actor}` and drop it: the host has nothing to check against, so it forwards
  // whatever arrived. Every spec now carries a closed object, empty ones included, and the host
  // refuses the extras for us.
  for (const spec of cotalToolSpecs(config, source)) {
    const inputSchema = selection ? spec.schema.extend({ identity: z.string().min(1).optional() }).strict() : spec.schema;
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: selection
          ? `${spec.description} Select an identity with the optional opaque identity handle; without one, the session default is used only when unambiguous.`
          : spec.description,
        inputSchema,
      },
      async (args: Record<string, unknown>) => {
        if (!selection) return toContent(await spec.run(agent, config, args));
        let selected: CotalMcpSelectedIdentity;
        try {
          selected = await selection.select(args.identity as string | undefined);
        } catch (error) {
          return selectedIdentityError(error);
        }
        const { identity: _identity, ...toolArgs } = args;
        const selectedSpec = cotalToolSpecs(selected.config, source).find((candidate) => candidate.name === spec.name);
        if (!selectedSpec) throw new Error(`Cotal MCP selector returned an identity without tool ${spec.name}`);
        const result = await selectedSpec.run(selected.agent, selected.config, toolArgs);
        return toContent({ ...result, text: `actingIdentity: ${selected.handle}\n${result.text}` });
      },
    );
  }
}
