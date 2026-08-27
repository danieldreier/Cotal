import { registry, type Command } from "@cotal-ai/core";
import { targetFlags } from "@cotal-ai/workspace";
import { runMcpGateway, type McpGatewayOptions } from "./gateway.js";

const command: Command = {
  kind: "command",
  name: "mcp",
  group: "Extensions",
  summary: "trusted local stdio MCP gateway with session-scoped Cotal identities",
  flags: [
    ...targetFlags,
    { name: "config", type: "string", value: "<file|name>", description: "persona envelope for gateway-created identities (wins over --persona)" },
    { name: "persona", type: "string", value: "<file|name>", description: "persona envelope for gateway-created identities" },
  ],
  async run(args): Promise<void> {
    const values = args.values as McpGatewayOptions;
    await runMcpGateway(values);
  },
};

registry.register(command);
export { runMcpGateway, type McpGatewayOptions } from "./gateway.js";
