import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { runMcpGateway, type McpGatewayOptions } from "./gateway.js";
import { runMcpGatewayHttp } from "./http.js";

interface McpCommandOptions extends McpGatewayOptions {
  transport?: string;
  port?: string;
}

function httpPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("cotal mcp: --port must be an integer from 0 through 65535");
  const port = Number(value);
  if (port > 65_535) throw new Error("cotal mcp: --port must be an integer from 0 through 65535");
  return port;
}

async function run(values: McpCommandOptions): Promise<void> {
  const transport = values.transport ?? "stdio";
  if (transport === "stdio") {
    if (values.port !== undefined) throw new Error("cotal mcp: --port requires --transport http");
    await runMcpGateway(values);
    return;
  }
  if (transport === "http") {
    await runMcpGatewayHttp(values, { port: httpPort(values.port) });
    return;
  }
  throw new Error("cotal mcp: --transport must be stdio or http");
}

const command: Command = {
  kind: "command",
  name: "mcp",
  group: "Extensions",
  summary: "trusted local MCP gateway with session-scoped Cotal identities",
  flags: [
    ...targetFlags,
    { name: "config", type: "string", value: "<file|name>", description: "persona envelope for gateway-created identities (wins over --persona)" },
    { name: "persona", type: "string", value: "<file|name>", description: "persona envelope for gateway-created identities" },
    { name: "transport", type: "string", value: "<stdio|http>", description: "MCP transport (stdio for local ChatGPT Desktop and Codex; http for optional hosted remote access)" },
    { name: "port", type: "string", value: "<0-65535>", description: "with --transport http: loopback port (0 chooses one; use an explicit port for optional tunnel-client access)" },
  ],
  async run(args): Promise<void> {
    await run(args.values as McpCommandOptions);
  },
};

registry.register(command);
export { runMcpGateway, type McpGatewayOptions } from "./gateway.js";
export { runMcpGatewayHttp, startMcpGatewayHttp, type McpHttpGateway, type McpHttpOptions } from "./http.js";
