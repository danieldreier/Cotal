/** Real stdio MCP gateway smoke: no fake broker, no fake client, no stub agent. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EmptyResultSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve())); return port;
}
async function reachable(server: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await isReachable(server)) return; await sleep(50); }
  throw new Error(`broker did not start at ${server}`);
}
function persona(root: string): void {
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "gateway.md"), "---\nname: gateway\nrole: operator\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\ngateway smoke persona\n");
}
function text(result: Awaited<ReturnType<Client["callTool"]>>): string { return result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n"); }
function receipt(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> { return JSON.parse(text(result)); }
async function waitFor(name: string, read: () => boolean, timeout = 10_000): Promise<void> {
  const until = Date.now() + timeout;
  while (!read()) { if (Date.now() > until) throw new Error(`timed out waiting for ${name}`); await sleep(50); }
}
async function rawStdioProbe(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ clean: boolean; instructions: string }> {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
  child.stdin?.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw-gateway-smoke","version":"0.0.0"}}}\n');
  await waitFor("raw initialize frame", () => stdout.includes("\n"));
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(5_000)]);
  const frames = stdout.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as { jsonrpc?: unknown; result?: { instructions?: unknown } }; } catch { return undefined; }
  });
  const initialized = frames.find((frame) => typeof frame?.result?.instructions === "string");
  return {
    clean: frames.every((frame) => frame?.jsonrpc === "2.0"),
    instructions: typeof initialized?.result?.instructions === "string" ? initialized.result.instructions : "",
  };
}

if (spawnSync("nats-server", ["-v"], { stdio: "ignore" }).error) { console.error("gateway smoke needs nats-server on PATH"); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), "cotal-mcp-home-")); process.env.COTAL_HOME = home;
const { authDir, prepareStandaloneAgent, recordMesh, resolveStandaloneAgent, saveSpaceAuth } = await import("@cotal-ai/workspace");
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const main = join(process.cwd(), "extensions", "mcp", "src", "mcp-main.ts");
let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => { assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`); passed++; console.log(`  ✓ ${name}`); };

async function cell(mode: "open" | "auth"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `cotal-mcp-${mode}-`)); const port = await freePort(); const server = `nats://127.0.0.1:${port}`; const space = `gateway-${mode}`;
  persona(root);
  let auth: Awaited<ReturnType<typeof createSpaceAuth>> | undefined; let broker: ChildProcess | undefined; let peer: CotalEndpoint | undefined; let peerPrepared: Awaited<ReturnType<typeof prepareStandaloneAgent>> | undefined; let client: Client | undefined; let transport: StdioClientTransport | undefined;
  try {
    if (mode === "auth") {
      auth = await createSpaceAuth(space); saveSpaceAuth(authDir(root), auth);
      const config = join(root, "nats.conf"); writeFileSync(config, serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(root, "js"), transport: { kind: "plaintext" } }));
      broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
    } else broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
    await reachable(server);
    const provisioner = auth ? await mintCreds(auth, newIdentity(), "provisioner") : undefined;
    await setupSpaceStreams({ servers: server, space, creds: provisioner }); recordMesh({ space, server, root, mode, tlsRequired: false, ts: new Date().toISOString() });
    if (auth) peerPrepared = await prepareStandaloneAgent({ resolved: resolveStandaloneAgent({ targetFlags: { space }, config: "gateway" }), name: `peer_${mode}` });
    const offline = new Set<string>();
    peer = new CotalEndpoint({ space, servers: server, creds: peerPrepared?.creds, lifecycleUid: peerPrepared?.lifecycleUid, channels: ["general"], card: { id: peerPrepared?.id, name: peerPrepared?.name ?? `peer-${mode}`, role: peerPrepared?.role ?? "witness", kind: "agent" } }); peer.on("error", () => {}); peer.on("presence", (event: { type: string; presence: { card: { id: string } } }) => { if (event.type === "offline") offline.add(event.presence.card.id); }); await peer.start();
    const stderr: string[] = [];
    const raw = await rawStdioProbe(tsx, [main, "--space", space, "--persona", "gateway"], root, { ...process.env, COTAL_HOME: home });
    check(`${mode}: raw newline-framed stdio has JSON-RPC-only stdout`, raw.clean);
    check(`${mode}: initialize teaches an unfamiliar host to open an identity, orient, and use the skill when available`, raw.instructions.includes("cotal_identity_open") && raw.instructions.includes("cotal_orientation") && raw.instructions.includes("$cotal-mesh"), raw.instructions);
    transport = new StdioClientTransport({ command: tsx, args: [main, "--space", space, "--persona", "gateway"], cwd: root, env: { ...process.env, COTAL_HOME: home }, stderr: "pipe" }); transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const updates: string[] = [];
    client = new Client({ name: "gateway-smoke", version: "0.0.0" }); client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => { updates.push(notification.params.uri); }); await client.connect(transport);
    const tools = await client.listTools(); check(`${mode}: initialize and tool discovery expose gateway identity tools`, ["cotal_identity_open", "cotal_identity_list", "cotal_identity_use", "cotal_identity_close"].every((name) => tools.tools.some((tool) => tool.name === name)));
    const first = receipt(await client.callTool({ name: "cotal_identity_open", arguments: { key: "one" } })); const one = String(first.identity);
    check(`${mode}: identity_open creates an opaque handle`, /^[0-9a-f-]{36}$/.test(one) && first.outcome === "opened", first);
    const again = receipt(await client.callTool({ name: "cotal_identity_open", arguments: { key: "one" } })); check(`${mode}: identity_open is idempotent per session key`, again.identity === one && again.outcome === "already-open", again);
    const two = String(receipt(await client.callTool({ name: "cotal_identity_open", arguments: { key: "two" } })).identity);
    const ambiguous = await client.callTool({ name: "cotal_roster", arguments: {} }); check(`${mode}: multiple identities never guess an actor`, ambiguous.isError === true && text(ambiguous).includes("IDENTITY_REQUIRED"), text(ambiguous));
    check(`${mode}: invalid handle is a structured refusal`, (await client.callTool({ name: "cotal_roster", arguments: { identity: "00000000-0000-4000-8000-000000000000" } })).isError === true);
    receipt(await client.callTool({ name: "cotal_identity_use", arguments: { identity: one } }));
    const context = JSON.parse((await client.readResource({ uri: "cotal://context" })).contents[0]?.text ?? "{}") as { identity?: { id?: string } };
    const onePrincipal = context.identity?.id;
    check(`${mode}: context identifies the selected concrete actor`, typeof onePrincipal === "string" && onePrincipal.length > 8, context);
    let witnessed = false; peer.on("message", (message: { parts: Array<{ kind: string; text?: string }> }, delivery: { ack(): void }) => { if (message.parts.some((part) => part.kind === "text" && part.text === `gateway-${mode}-send`)) witnessed = true; delivery.ack(); });
    const sent = await client.callTool({ name: "cotal_send", arguments: { identity: one, channel: "general", text: `gateway-${mode}-send` } }); check(`${mode}: gateway send declares its acting identity`, !sent.isError && text(sent).startsWith(`actingIdentity: ${one}`), text(sent)); await waitFor(`${mode} gateway send witness`, () => witnessed);
    await client.request({ method: "resources/subscribe", params: { uri: "cotal://inbox" } }, EmptyResultSchema);
    await peer.unicast(onePrincipal!, `peer-${mode}-inbox`); await sleep(200);
    check(`${mode}: selected child inbox updates the shared resource subscription`, updates.includes("cotal://inbox"), updates);
    const peekOne = await client.readResource({ uri: "cotal://inbox" }); const peekTwo = await client.readResource({ uri: "cotal://inbox" }); check(`${mode}: inbox resource is forced peek on repeated read`, (peekOne.contents[0]?.text ?? "").includes(`peer-${mode}-inbox`) && (peekTwo.contents[0]?.text ?? "").includes(`peer-${mode}-inbox`));
    const other = await client.callTool({ name: "cotal_send", arguments: { identity: two, channel: "general", text: `gateway-${mode}-two` } }); check(`${mode}: explicit identity isolates the second actor`, !other.isError && text(other).startsWith(`actingIdentity: ${two}`), text(other));
    const closed = receipt(await client.callTool({ name: "cotal_identity_close", arguments: { identity: two } })); check(`${mode}: close stops and retires the selected identity`, closed.outcome === "closed", closed);
    const afterClose = await client.callTool({ name: "cotal_roster", arguments: { identity: two } }); check(`${mode}: closed handles cannot be reused`, afterClose.isError === true && text(afterClose).includes("IDENTITY_NOT_FOUND"), text(afterClose));
    check(`${mode}: stdio diagnostics stay off JSON-RPC stdout`, stderr.some((line) => line.includes("stdio gateway ready")));
    await client.close(); client = undefined;
    await waitFor(`${mode} gateway EOF cleanup`, () => offline.has(onePrincipal!));
    check(`${mode}: EOF stops the remaining MeshAgent and publishes offline presence`, offline.has(onePrincipal!));
  } finally { await client?.close().catch(() => {}); await transport?.close().catch(() => {}); await peer?.stop().catch(() => {}); await peerPrepared?.retire().catch(() => {}); broker?.kill("SIGTERM"); if (broker) await Promise.race([once(broker, "exit"), sleep(5_000)]); rmSync(root, { recursive: true, force: true }); }
}

try { await cell("open"); await cell("auth"); check("every real-broker cell completed", passed === 32, passed); console.log("MCP GATEWAY SMOKE OK ✅"); } finally { rmSync(home, { recursive: true, force: true }); }
