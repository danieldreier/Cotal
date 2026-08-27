#!/usr/bin/env node
import { runMcpGateway, type McpGatewayOptions } from "./gateway.js";

function options(argv: string[]): McpGatewayOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`cotal-mcp: unknown positional ${arg}`);
    const key = arg.slice(2);
    if (!["space", "server", "persona", "config"].includes(key)) throw new Error(`cotal-mcp: unknown flag --${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`cotal-mcp: --${key} requires a value`);
    values[key] = value;
  }
  return values;
}

runMcpGateway(options(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`[cotal-mcp] fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
