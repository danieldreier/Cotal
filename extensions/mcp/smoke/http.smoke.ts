/**
 * Real Streamable HTTP gateway smoke. It starts a real NATS broker, provisions
 * actual Cotal identities, and drives the emitted loopback URL through the MCP
 * SDK's HTTP client. No in-memory transport or fake MeshAgent participates.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request, createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { startMcpGatewayHttp } from "../src/http.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const listener = createNetServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
async function reachable(server: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await isReachable(server)) return; await sleep(50); }
  throw new Error(`broker did not start at ${server}`);
}
function persona(root: string): void {
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "gateway.md"), "---\nname: gateway\nrole: operator\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\ngateway HTTP smoke persona\n");
}
function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
}
function receipt(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> { return JSON.parse(text(result)); }
async function waitFor(name: string, read: () => boolean, timeout = 10_000): Promise<void> {
  const until = Date.now() + timeout;
  while (!read()) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(50); }
}
async function raw(url: string, method: string, body?: string, host?: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method,
      headers: {
        Host: host ?? target.host,
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

if (spawnSync("nats-server", ["-v"], { stdio: "ignore" }).error) { console.error("HTTP gateway smoke needs nats-server on PATH"); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), "cotal-mcp-http-home-")); process.env.COTAL_HOME = home;
const { authDir, prepareStandaloneAgent, recordMesh, resolveStandaloneAgent, saveSpaceAuth } = await import("@cotal-ai/workspace");
let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`); passed++; console.log(`  ✓ ${name}`);
};

async function cell(mode: "open" | "static"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `cotal-mcp-http-${mode}-`));
  const originalCwd = process.cwd();
  const port = await freePort(); const server = `nats://127.0.0.1:${port}`; const space = `gateway-http-${mode}`;
  persona(root);
  let auth: Awaited<ReturnType<typeof createSpaceAuth>> | undefined;
  let broker: ChildProcess | undefined;
  let peer: CotalEndpoint | undefined;
  let peerPrepared: Awaited<ReturnType<typeof prepareStandaloneAgent>> | undefined;
  let gateway: Awaited<ReturnType<typeof startMcpGatewayHttp>> | undefined;
  let client: Client | undefined;
  try {
    if (mode === "static") {
      auth = await createSpaceAuth(space); saveSpaceAuth(authDir(root), auth);
      const config = join(root, "nats.conf");
      writeFileSync(config, serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(root, "js"), transport: { kind: "plaintext" } }));
      broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
    } else {
      broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
    }
    await reachable(server);
    const provisioner = auth ? await mintCreds(auth, newIdentity(), "provisioner") : undefined;
    await setupSpaceStreams({ servers: server, space, creds: provisioner });
    recordMesh({ space, server, root, mode: mode === "static" ? "auth" : "open", tlsRequired: false, ts: new Date().toISOString() });
    if (auth) peerPrepared = await prepareStandaloneAgent({ resolved: resolveStandaloneAgent({ targetFlags: { space }, config: "gateway" }), name: `peer_${mode}` });
    const offline = new Set<string>();
    peer = new CotalEndpoint({
      space, servers: server, creds: peerPrepared?.creds, lifecycleUid: peerPrepared?.lifecycleUid, channels: ["general"],
      card: { id: peerPrepared?.id, name: peerPrepared?.name ?? `peer-${mode}`, role: peerPrepared?.role ?? "witness", kind: "agent" },
    });
    peer.on("error", () => {});
    peer.on("presence", (event: { type: string; presence: { card: { id: string } } }) => { if (event.type === "offline") offline.add(event.presence.card.id); });
    await peer.start();
    process.chdir(root);
    gateway = await startMcpGatewayHttp({ space, persona: "gateway" });

    const hostDenied = await raw(gateway.url, "POST", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), "example.invalid");
    check(`${mode}: exact loopback Host guard rejects rebinding`, hostDenied.status === 403, hostDenied);
    const noInitialize = await raw(gateway.url, "POST", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    check(`${mode}: only initialize creates an HTTP session`, noInitialize.status === 400 && noInitialize.body.includes("initialize is required"), noInitialize);
    const tooLarge = await raw(gateway.url, "POST", "x".repeat(4 * 1024 * 1024 + 1));
    check(`${mode}: bounded HTTP request bodies fail clearly`, tooLarge.status === 413, tooLarge.status);

    client = new Client({ name: "gateway-http-smoke", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)));
    const tools = await client.listTools();
    check(`${mode}: HTTP client initializes and discovers multi-identity tools`, ["cotal_identity_open", "cotal_identity_list", "cotal_identity_use"].every((name) => tools.tools.some((tool) => tool.name === name)));
    const opened = receipt(await client.callTool({ name: "cotal_identity_open", arguments: { key: "operator" } }));
    const identity = String(opened.identity);
    check(`${mode}: HTTP session provisions a fresh opaque identity`, /^[0-9a-f-]{36}$/.test(identity) && opened.outcome === "opened", opened);
    const context = JSON.parse((await client.readResource({ uri: "cotal://context" })).contents[0]?.text ?? "{}") as { identity?: { id?: string } };
    const principal = context.identity?.id;
    check(`${mode}: context reports the HTTP-selected actor`, typeof principal === "string" && principal.length > 8, context);
    let witnessed = false;
    peer.on("message", (message: { parts: Array<{ kind: string; text?: string }> }, delivery: { ack(): void }) => {
      if (message.parts.some((part) => part.kind === "text" && part.text === `http-${mode}-send`)) witnessed = true;
      delivery.ack();
    });
    const sent = await client.callTool({ name: "cotal_send", arguments: { channel: "general", text: `http-${mode}-send` } });
    check(`${mode}: HTTP Cotal write names its actor`, !sent.isError && text(sent).startsWith(`actingIdentity: ${identity}`), text(sent));
    await waitFor(`${mode} HTTP send witness`, () => witnessed);
    await peer.unicast(principal!, `http-${mode}-inbox`);
    await sleep(150);
    const peekOne = await client.readResource({ uri: "cotal://inbox" });
    const peekTwo = await client.readResource({ uri: "cotal://inbox" });
    check(`${mode}: HTTP inbox resource remains a non-acking repeated peek`, (peekOne.contents[0]?.text ?? "").includes(`http-${mode}-inbox`) && (peekTwo.contents[0]?.text ?? "").includes(`http-${mode}-inbox`));

    await client.close(); client = undefined;
    await gateway.close(); gateway = undefined;
    await waitFor(`${mode} HTTP gateway shutdown`, () => offline.has(principal!));
    check(`${mode}: shutdown retires the session identity and leaves presence`, offline.has(principal!));

    const bounded = await startMcpGatewayHttp({ space, persona: "gateway" }, { maxSessions: 1, idleTtlMs: 75 });
    const first = new Client({ name: "http-cap-first", version: "0.0.0" });
    const second = new Client({ name: "http-cap-second", version: "0.0.0" });
    try {
      await first.connect(new StreamableHTTPClientTransport(new URL(bounded.url)));
      await second.connect(new StreamableHTTPClientTransport(new URL(bounded.url)));
      await assert.rejects(first.listTools());
      check(`${mode}: max-session eviction closes the least-recently-used real HTTP session`, true);
      await second.listTools();
      await sleep(180);
      await assert.rejects(second.listTools());
      check(`${mode}: idle TTL expires a real HTTP session`, true);
    } finally {
      await first.close().catch(() => {});
      await second.close().catch(() => {});
      await bounded.close();
    }
  } finally {
    await client?.close().catch(() => {});
    await gateway?.close().catch(() => {});
    await peer?.stop().catch(() => {});
    await peerPrepared?.retire().catch(() => {});
    broker?.kill("SIGTERM");
    if (broker) await Promise.race([once(broker, "exit"), sleep(5_000)]);
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  await cell("open");
  await cell("static");
  check("every real HTTP/broker cell completed", passed === 22, passed);
  console.log("MCP HTTP GATEWAY SMOKE OK ✅");
} finally {
  rmSync(home, { recursive: true, force: true });
}
