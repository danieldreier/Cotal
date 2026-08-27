/**
 * Loopback-only Streamable HTTP transport for a trusted local Cotal MCP gateway.
 *
 * This listener is intentionally not an Internet-facing authentication system.
 * ChatGPT reaches it only through the operator-run Secure MCP Tunnel in the same
 * host trust boundary. The listener rejects non-loopback peers and Host-header
 * rebinding, and each MCP session gets a separate identity registry.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpGatewayServer, type McpGatewayOptions, type McpGatewayServer } from "./gateway.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 8;
const IDLE_TTL_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface McpHttpOptions {
  /** Loopback port. `0` asks the OS for one; tunnel profiles normally use an explicit port. */
  port?: number;
  /** Test-only bounds; production retains the conservative constants above. */
  maxSessions?: number;
  idleTtlMs?: number;
  requestTimeoutMs?: number;
}

export interface McpHttpGateway {
  /** Exact secret-free loopback endpoint to supply to tunnel-client. */
  url: string;
  /** Stop admission, close every MCP session, then retire all session identities. */
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  gateway: McpGatewayServer;
  lastUsed: number;
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function loopbackRequest(req: IncomingMessage, port: number): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) return false;
  const host = req.headers.host ?? "";
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function requestBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    throw new BodyError(413, "request body is too large");
  }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      req.destroy();
      done(new BodyError(408, "request body timed out"));
    }, timeoutMs);
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        done(new BodyError(413, "request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => done());
    req.once("error", (error) => done(error instanceof Error ? error : new Error(String(error))));
    req.once("aborted", () => done(new BodyError(400, "request body was aborted")));
  });
  if (!raw.length) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BodyError(400, "request body is not valid JSON");
  }
}

/**
 * Start the private HTTP transport. The tunnel (not a client-provided bearer)
 * authenticates the remote ChatGPT connection. Refusing a non-loopback peer is
 * therefore mandatory: ordinary plain HTTP is never a public deployment mode.
 */
export async function startMcpGatewayHttp(
  gatewayOptions: McpGatewayOptions = {},
  options: McpHttpOptions = {},
): Promise<McpHttpGateway> {
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const idleTtlMs = options.idleTtlMs ?? IDLE_TTL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("cotal mcp http: maxSessions must be a positive integer");
  if (!Number.isFinite(idleTtlMs) || idleTtlMs < 1) throw new Error("cotal mcp http: idleTtlMs must be positive");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error("cotal mcp http: requestTimeoutMs must be positive");

  const sessions = new Map<string, Session>();
  let port = 0;
  let accepting = true;
  let stopping: Promise<void> | undefined;
  const drop = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    // Close the HTTP transport first. It owns any outstanding SSE/long-poll
    // response, so closing the TCP listener first could wait forever. The
    // gateway then retires its MeshAgent identities after the client route is
    // gone.
    await session.transport.close().catch(() => {});
    await session.gateway.close();
  };
  const reapIdle = (): void => {
    const cutoff = Date.now() - idleTtlMs;
    for (const [id, session] of sessions) if (session.lastUsed <= cutoff) void drop(id);
  };

  const http: Server = createServer((req, res) => {
    void (async () => {
      if (!accepting) {
        json(res, 503, { error: "cotal MCP gateway is shutting down" });
        return;
      }
      if (!loopbackRequest(req, port)) {
        json(res, 403, { error: "cotal MCP accepts only exact loopback requests" });
        return;
      }
      if ((req.url ?? "") !== MCP_PATH) {
        json(res, 404, { error: "not found" });
        return;
      }
      if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        res.writeHead(405, { allow: "POST, GET, DELETE" }).end();
        return;
      }

      let body: unknown;
      if (req.method === "POST") {
        try {
          body = await requestBody(req, requestTimeoutMs);
        } catch (error) {
          const failure = error instanceof BodyError ? error : new BodyError(400, (error as Error).message);
          json(res, failure.status, failure.status === 400
            ? { jsonrpc: "2.0", error: { code: -32700, message: failure.message }, id: null }
            : { error: failure.message });
          return;
        }
      }

      const rawSessionId = req.headers["mcp-session-id"];
      if (Array.isArray(rawSessionId)) {
        json(res, 400, { error: "multiple mcp-session-id headers are invalid" });
        return;
      }
      const sessionId = rawSessionId;
      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "unknown or expired MCP session" }, id: null });
          return;
        }
        existing.lastUsed = Date.now();
        // `Map` preserves insertion order. Reinsertion makes eviction true
        // LRU rather than merely creation-order capped.
        sessions.delete(sessionId);
        sessions.set(sessionId, existing);
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      // Only an initialize POST can create a session. The session id is routing
      // metadata, never a credential or authorization decision.
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "initialize is required before this MCP request" }, id: null });
        return;
      }
      const gateway = await createMcpGatewayServer(gatewayOptions);
      let initializedId: string | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (!accepting) {
            void transport.close();
            void gateway.close();
            return;
          }
          initializedId = id;
          sessions.set(id, { transport, gateway, lastUsed: Date.now() });
          // Map insertion order is last-used order because touch reinserts
          // above; overflow therefore evicts the least-recently-used session.
          while (sessions.size > maxSessions) {
            const oldest = sessions.keys().next().value as string | undefined;
            if (!oldest) break;
            void drop(oldest);
          }
        },
      });
      transport.onclose = () => { if (initializedId) void drop(initializedId); };
      try {
        await gateway.server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (initializedId) await drop(initializedId);
        else await gateway.close();
        throw error;
      }
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { error: `cotal MCP request failed: ${(error as Error).message}` });
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("cotal mcp http: did not bind a TCP port");
  port = address.port;
  const timer = setInterval(reapIdle, Math.min(idleTtlMs, 60_000));
  timer.unref();
  const url = `http://127.0.0.1:${port}${MCP_PATH}`;

  return {
    url,
    close: () => (stopping ??= (async () => {
      accepting = false;
      clearInterval(timer);
      await Promise.all([...sessions.keys()].map((id) => drop(id)));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    })()),
  };
}

/** Run the loopback HTTP product until the operator stops it. The printed URL
 * contains no credential: tunnel-client remains entirely operator-managed. */
export async function runMcpGatewayHttp(
  gatewayOptions: McpGatewayOptions = {},
  options: McpHttpOptions = {},
): Promise<void> {
  const gateway = await startMcpGatewayHttp(gatewayOptions, options);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => (stopping ??= (async () => {
    await gateway.close();
    finish();
  })());
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stderr.write(`[cotal-mcp] private HTTP gateway ready at ${gateway.url}\n`);
  await done;
}
