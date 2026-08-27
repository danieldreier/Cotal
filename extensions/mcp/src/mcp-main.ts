#!/usr/bin/env node
import { runMcpGateway, type McpGatewayOptions } from "./gateway.js";
import { runMcpGatewayHttp } from "./http.js";

interface McpCommandOptions extends McpGatewayOptions {
  transport?: string;
  port?: string;
}

function options(argv: string[]): McpCommandOptions {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`cotal-mcp: unknown positional ${arg}`);
    const key = arg.slice(2);
    if (!["space", "server", "persona", "config", "transport", "port"].includes(key)) throw new Error(`cotal-mcp: unknown flag --${key}`);
    if (values[key] !== undefined) throw new Error(`cotal-mcp: --${key} may be supplied only once`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`cotal-mcp: --${key} requires a value`);
    values[key] = value;
  }
  return values;
}

function httpPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("cotal-mcp: --port must be an integer from 0 through 65535");
  const port = Number(value);
  if (port > 65_535) throw new Error("cotal-mcp: --port must be an integer from 0 through 65535");
  return port;
}

async function main(): Promise<void> {
  const values = options(process.argv.slice(2));
  const transport = values.transport ?? "stdio";
  if (transport === "stdio") {
    if (values.port !== undefined) throw new Error("cotal-mcp: --port requires --transport http");
    await runMcpGateway(values);
    return;
  }
  if (transport === "http") {
    await runMcpGatewayHttp(values, { port: httpPort(values.port) });
    return;
  }
  throw new Error("cotal-mcp: --transport must be stdio or http");
}

main().catch((error) => {
  process.stderr.write(`[cotal-mcp] fatal: ${(error as Error).message}\n`);
  process.exit(1);
});
