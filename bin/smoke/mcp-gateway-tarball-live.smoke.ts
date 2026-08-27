/**
 * Published-artifact MCP smoke. It packs the complete Cotal closure, installs
 * it under a fresh npm prefix, adds the packed @cotal-ai/mcp extension through
 * the installed `cotal` binary, and speaks MCP to that installed binary over
 * stdio while a real NATS broker and witness prove mesh effects. Source imports
 * are only the test harness/broker witness: the product child resolves solely
 * from the installed prefix and its isolated HOME/XDG/COTAL_HOME.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
async function reachable(server: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (await isReachable(server)) return; await sleep(50); }
  throw new Error(`broker did not start at ${server}`);
}
async function waitFor(name: string, read: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!read()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`); await sleep(50); }
}
function persona(root: string): void {
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "gateway.md"), "---\nname: gateway\nrole: operator\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\ninstalled gateway smoke persona\n");
}
function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return result.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
}
function receipt(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> { return JSON.parse(text(result)); }
function packageName(tarball: string): string {
  return (JSON.parse(execFileSync("tar", ["xzf", tarball, "-O", "package/package.json"], { encoding: "utf8" })) as { name: string }).name;
}

if (spawnSync("nats-server", ["-v"], { stdio: "ignore" }).error) { console.error("installed MCP smoke needs nats-server on PATH"); process.exit(2); }
const { authDir, prepareStandaloneAgent, recordMesh, resolveStandaloneAgent, saveSpaceAuth } = await import("@cotal-ai/workspace");
const runRealCodex = /^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_CODEX ?? "");
const base = mkdtempSync(join(tmpdir(), "cotal-mcp-tarball-"));
const tarballsDir = join(base, "tarballs"); const prefix = join(base, "prefix");
const mcpPayload = join(base, "mcp-payload");
const npmCache = join(base, "npm-cache");
mkdirSync(tarballsDir, { recursive: true }); mkdirSync(prefix, { recursive: true }); mkdirSync(npmCache, { recursive: true });
// Packing `cotal-ai` runs its existing seeded-connector prepack, which invokes
// npm itself. Keep that cache inside this disposable artifact test: a broken or
// root-owned operator cache must not make a release validation lie or mutate a
// developer's home directory.
process.env.NPM_CONFIG_CACHE = npmCache;
let passed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : `: ${JSON.stringify(actual)}`}`); passed++; console.log(`  ✓ ${name}`);
};

try {
  const dirs = [
    "bin", "packages/core", "packages/workspace", "implementations/cli", "implementations/manager",
    "implementations/delivery", "implementations/auth", "extensions/connector-core", "extensions/mcp",
  ];
  for (const dir of dirs) execFileSync("pnpm", ["-C", join(REPO, dir), "pack", "--pack-destination", tarballsDir], { stdio: ["ignore", "ignore", "inherit"] });
  const tarballs = readdirSync(tarballsDir).filter((name) => name.endsWith(".tgz")).map((name) => join(tarballsDir, name));
  check("packed the complete Cotal + MCP extension closure", tarballs.length === dirs.length, tarballs.length);
  const byPackage = new Map(tarballs.map((tarball) => [packageName(tarball), tarball]));
  const cotalTgz = byPackage.get("cotal-ai"); const mcpTgz = byPackage.get("@cotal-ai/mcp");
  if (!cotalTgz || !mcpTgz) throw new Error("packed closure did not include cotal-ai and @cotal-ai/mcp");
  const cotalPackage = execFileSync("tar", ["xzf", cotalTgz, "-O", "package/package.json"], { encoding: "utf8" });
  const mcpListing = execFileSync("tar", ["tzf", mcpTgz], { encoding: "utf8" });
  check("packed cotal-ai contains concrete dependency versions", !cotalPackage.includes("workspace:"));
  check("packed MCP extension contains its command and HTTP/stdio exports", mcpListing.includes("package/dist/mcp-main.js") && mcpListing.includes("package/dist/http.js") && mcpListing.includes("package/dist/index.js"));
  // `cotal ext add` deliberately accepts a directory package, not a tarball
  // pathname. Unpack the just-produced tarball into a disposable directory so
  // the product receives a normal installed-artifact input with no checkout
  // path on its resolution chain.
  mkdirSync(mcpPayload, { recursive: true });
  execFileSync("tar", ["xzf", mcpTgz, "-C", mcpPayload, "--strip-components=1"]);
  check("extension add input is the unpacked MCP artifact, never source", existsSync(join(mcpPayload, "dist", "index.js")));

  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "cotal-mcp-installed-smoke", private: true }));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs], { cwd: prefix, encoding: "utf8" });
  check("npm installed the packed closure into an empty prefix", install.status === 0, install.stderr?.split("\n").slice(-8).join("\n"));
  const npmBin = join(prefix, "node_modules", ".bin", "cotal");
  const installedCotal = process.platform === "win32" ? join(prefix, "node_modules", "cotal-ai", "dist", "cotal.js") : npmBin;
  check("the product is invoked through npm's installed cotal bin", existsSync(installedCotal) && (process.platform === "win32" || lstatSync(npmBin).isSymbolicLink()));

  async function cell(mode: "open" | "static"): Promise<void> {
    const root = join(base, `project-${mode}`); const home = join(base, `home-${mode}`); const configHome = join(base, `config-${mode}`); const cotalHome = join(base, `cotal-home-${mode}`);
    for (const dir of [root, home, configHome, cotalHome]) mkdirSync(dir, { recursive: true });
    persona(root);
    const priorHome = process.env.COTAL_HOME;
    process.env.COTAL_HOME = cotalHome;
    const originalCwd = process.cwd();
    const port = await freePort(); const server = `nats://127.0.0.1:${port}`; const space = `installed-mcp-${mode}-${process.pid}`;
    let broker: ChildProcess | undefined; let auth: Awaited<ReturnType<typeof createSpaceAuth>> | undefined;
    let peer: CotalEndpoint | undefined; let peerPrepared: Awaited<ReturnType<typeof prepareStandaloneAgent>> | undefined;
    let client: Client | undefined; let transport: StdioClientTransport | undefined;
    let httpChild: ChildProcess | undefined; let httpClient: Client | undefined;
    try {
      if (mode === "static") {
        auth = await createSpaceAuth(space); saveSpaceAuth(authDir(root), auth);
        const brokerConfig = join(root, "nats.conf");
        writeFileSync(brokerConfig, serverConfig(auth, [auth], { host: "127.0.0.1", port, storeDir: join(root, "js"), transport: { kind: "plaintext" } }));
        broker = spawn("nats-server", ["-c", brokerConfig], { stdio: "ignore" });
      } else {
        broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
      }
      await reachable(server);
      const provisioner = auth ? await mintCreds(auth, newIdentity(), "provisioner") : undefined;
      await setupSpaceStreams({ servers: server, space, creds: provisioner });
      recordMesh({ space, server, root, mode: mode === "static" ? "auth" : "open", tlsRequired: false, ts: new Date().toISOString() });
      process.chdir(root);
      if (auth) peerPrepared = await prepareStandaloneAgent({ resolved: resolveStandaloneAgent({ targetFlags: { space }, config: "gateway" }), name: `installed_peer_${mode}` });
      const offline = new Set<string>();
      peer = new CotalEndpoint({
        space, servers: server, creds: peerPrepared?.creds, lifecycleUid: peerPrepared?.lifecycleUid, channels: ["general"],
        card: { id: peerPrepared?.id, name: peerPrepared?.name ?? `installed-peer-${mode}`, role: peerPrepared?.role ?? "witness", kind: "agent" },
      });
      peer.on("error", () => {});
      peer.on("presence", (event: { type: string; presence: { card: { id: string } } }) => { if (event.type === "offline") offline.add(event.presence.card.id); });
      await peer.start();

      const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];
      const env: NodeJS.ProcessEnv = { ...cleanEnv, HOME: home, XDG_CONFIG_HOME: configHome, COTAL_HOME: cotalHome };
      const added = spawnSync(process.execPath, [installedCotal, "ext", "add", mcpPayload], { cwd: root, env, encoding: "utf8" });
      check(`${mode}: installed cotal adds the packed MCP extension into its private prefix`, added.status === 0, `${added.stdout}\n${added.stderr}`);
      const installedExtension = join(configHome, "cotal", "extensions", "node_modules", "@cotal-ai", "mcp", "dist", "index.js");
      check(`${mode}: extension dispatch resolves the packed dist rather than this checkout`, existsSync(installedExtension), installedExtension);

      transport = new StdioClientTransport({ command: process.execPath, args: [installedCotal, "mcp", "--space", space, "--config", "gateway"], cwd: root, env, stderr: "pipe" });
      const stderr: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      client = new Client({ name: "installed-mcp-smoke", version: "0.0.0" });
      await client.connect(transport);
      const tools = await client.listTools();
      check(`${mode}: installed command discovers the real trusted-identity MCP surface`, ["cotal_identity_open", "cotal_orientation", "cotal_inbox", "cotal_send"].every((name) => tools.tools.some((tool) => tool.name === name)));
      const opened = receipt(await client.callTool({ name: "cotal_identity_open", arguments: { key: "operator" } }));
      const identity = String(opened.identity);
      check(`${mode}: installed gateway creates a fresh identity from the persona envelope`, /^[0-9a-f-]{36}$/.test(identity) && opened.outcome === "opened", opened);
      const context = JSON.parse((await client.readResource({ uri: "cotal://context" })).contents[0]?.text ?? "{}") as { identity?: { id?: string } };
      const principal = context.identity?.id;
      check(`${mode}: installed gateway orientation identifies the selected real mesh actor`, typeof principal === "string" && principal.length > 8, context);
      let witnessed = false;
      peer.on("message", (message: { parts: Array<{ kind: string; text?: string }> }, delivery: { ack(): void }) => {
        if (message.parts.some((part) => part.kind === "text" && part.text === `installed-${mode}-send`)) witnessed = true;
        delivery.ack();
      });
      const sent = await client.callTool({ name: "cotal_send", arguments: { channel: "general", text: `installed-${mode}-send` } });
      check(`${mode}: installed gateway writes to a real mesh witness with its selected identity`, !sent.isError && text(sent).startsWith(`actingIdentity: ${identity}`), text(sent));
      await waitFor(`${mode} installed send witness`, () => witnessed);
      await peer.unicast(principal!, `installed-${mode}-inbox`); await sleep(150);
      const firstPeek = await client.readResource({ uri: "cotal://inbox" }); const secondPeek = await client.readResource({ uri: "cotal://inbox" });
      check(`${mode}: installed inbox resource remains a repeated non-acking peek`, (firstPeek.contents[0]?.text ?? "").includes(`installed-${mode}-inbox`) && (secondPeek.contents[0]?.text ?? "").includes(`installed-${mode}-inbox`));
      check(`${mode}: installed command keeps diagnostics off stdout`, stderr.some((line) => line.includes("stdio gateway ready")));
      await client.close(); client = undefined;
      await waitFor(`${mode} installed gateway EOF cleanup`, () => offline.has(principal!));
      check(`${mode}: installed gateway EOF retires the actual child identity`, offline.has(principal!));

      // ChatGPT uses this exact installed command through a Secure MCP Tunnel,
      // not the stdio transport above. Prove its shipped composition root once
      // here using the real Streamable HTTP SDK and the same real witness.
      if (mode === "open") {
        const httpPort = await freePort(); let httpStderr = "";
        httpChild = spawn(process.execPath, [installedCotal, "mcp", "--transport", "http", "--port", String(httpPort), "--space", space, "--config", "gateway"], {
          cwd: root, env, stdio: ["ignore", "ignore", "pipe"],
        });
        httpChild.stderr?.on("data", (chunk: Buffer) => { httpStderr += chunk.toString(); });
        const httpUrl = `http://127.0.0.1:${httpPort}/mcp`;
        await waitFor("installed HTTP gateway readiness", () => httpStderr.includes(httpUrl));
        check("open: installed cotal mcp --transport http announces only its secret-free loopback URL", httpStderr.includes(`private HTTP gateway ready at ${httpUrl}`), httpStderr);
        httpClient = new Client({ name: "installed-mcp-http-smoke", version: "0.0.0" });
        await httpClient.connect(new StreamableHTTPClientTransport(new URL(httpUrl)));
        const httpTools = await httpClient.listTools();
        check("open: installed HTTP command exposes the trusted identity surface", httpTools.tools.some((tool) => tool.name === "cotal_identity_open") && httpTools.tools.some((tool) => tool.name === "cotal_send"));
        const httpOpened = receipt(await httpClient.callTool({ name: "cotal_identity_open", arguments: { key: "http-operator" } }));
        const httpIdentity = String(httpOpened.identity);
        const httpContext = JSON.parse((await httpClient.readResource({ uri: "cotal://context" })).contents[0]?.text ?? "{}") as { identity?: { id?: string } };
        const httpPrincipal = httpContext.identity?.id;
        check("open: installed HTTP command provisions a distinct real actor", /^[0-9a-f-]{36}$/.test(httpIdentity) && typeof httpPrincipal === "string", httpOpened);
        let httpWitnessed = false;
        peer.on("message", (message: { parts: Array<{ kind: string; text?: string }> }, delivery: { ack(): void }) => {
          if (message.parts.some((part) => part.kind === "text" && part.text === "installed-http-send")) httpWitnessed = true;
          delivery.ack();
        });
        const httpSent = await httpClient.callTool({ name: "cotal_send", arguments: { channel: "general", text: "installed-http-send" } });
        await waitFor("installed HTTP send witness", () => httpWitnessed);
        check("open: installed HTTP command sends through the selected real actor", !httpSent.isError && text(httpSent).startsWith(`actingIdentity: ${httpIdentity}`), text(httpSent));
        await peer.unicast(httpPrincipal!, "installed-http-inbox"); await sleep(150);
        const httpPeekOne = await httpClient.readResource({ uri: "cotal://inbox" }); const httpPeekTwo = await httpClient.readResource({ uri: "cotal://inbox" });
        check("open: installed HTTP inbox keeps its forced repeated peek", (httpPeekOne.contents[0]?.text ?? "").includes("installed-http-inbox") && (httpPeekTwo.contents[0]?.text ?? "").includes("installed-http-inbox"));
        await httpClient.close(); httpClient = undefined;
        httpChild.kill("SIGTERM");
        await Promise.race([once(httpChild, "exit"), sleep(10_000)]);
        await waitFor("installed HTTP gateway shutdown", () => offline.has(httpPrincipal!));
        check("open: installed HTTP SIGTERM retires its child identity", offline.has(httpPrincipal!));
        httpChild = undefined;
      }
    } finally {
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
      await httpClient?.close().catch(() => {});
      if (httpChild && httpChild.exitCode === null) {
        httpChild.kill("SIGTERM");
        await Promise.race([once(httpChild, "exit"), sleep(10_000)]);
      }
      await peer?.stop().catch(() => {});
      await peerPrepared?.retire().catch(() => {});
      broker?.kill("SIGTERM");
      if (broker) await Promise.race([once(broker, "exit"), sleep(5_000)]);
      process.chdir(originalCwd);
      if (priorHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = priorHome;
    }
  }

  /** Credential-gated host acceptance. The Cotal side is still the installed
   * tarball product; source imports below only create the real broker witness. */
  async function codexCell(): Promise<void> {
    const codex = process.env.COTAL_CODEX_BIN ?? "codex";
    const probe = spawnSync(codex, ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error(`real Codex acceptance requires an executable codex CLI: ${probe.stderr || probe.error?.message || "not found"}`);
    const authSource = process.env.COTAL_E2E_CODEX_AUTH ?? join(process.env.HOME ?? "", ".codex", "auth.json");
    if (!existsSync(authSource)) throw new Error(`real Codex acceptance needs auth at ${authSource}; set COTAL_E2E_CODEX_AUTH to use a different existing file`);

    const root = join(base, "project-codex"); const home = join(base, "home-codex"); const configHome = join(base, "config-codex");
    const cotalHome = join(base, "cotal-home-codex"); const codexHome = join(home, ".codex");
    for (const dir of [root, home, configHome, cotalHome, codexHome]) mkdirSync(dir, { recursive: true });
    // Do not copy, inspect, or print the operator credential. Codex reads this
    // one transient link exactly as it does in its normal local login flow.
    symlinkSync(authSource, join(codexHome, "auth.json"));
    const originalCwd = process.cwd(); const priorCotalHome = process.env.COTAL_HOME;
    const port = await freePort(); const server = `nats://127.0.0.1:${port}`; const space = `installed-mcp-codex-${process.pid}`;
    const nonce = `cotal-codex-mcp-${process.pid}-${Date.now()}`;
    let broker: ChildProcess | undefined; let peer: CotalEndpoint | undefined;
    try {
      persona(root); process.env.COTAL_HOME = cotalHome; process.chdir(root);
      broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
      await reachable(server);
      await setupSpaceStreams({ servers: server, space });
      recordMesh({ space, server, root, mode: "open", tlsRequired: false, ts: new Date().toISOString() });
      let witnessed = false;
      peer = new CotalEndpoint({ space, servers: server, channels: ["general"], card: { id: "codex_witness", name: "codex-witness", role: "witness", kind: "agent" } });
      peer.on("error", () => {});
      peer.on("message", (message: { parts: Array<{ kind: string; text?: string }> }, delivery: { ack(): void }) => {
        if (message.parts.some((part) => part.kind === "text" && part.text === nonce)) witnessed = true;
        delivery.ack();
      });
      await peer.start();

      const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];
      const productBin = join(prefix, "node_modules", ".bin");
      const env: NodeJS.ProcessEnv = {
        ...cleanEnv, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: configHome, COTAL_HOME: cotalHome,
        PATH: `${productBin}:${cleanEnv.PATH ?? ""}`,
      };
      const added = spawnSync(process.execPath, [installedCotal, "ext", "add", mcpPayload], { cwd: root, env, encoding: "utf8" });
      check("real Codex lane installs the packed MCP extension with the installed cotal binary", added.status === 0, `${added.stdout}\n${added.stderr}`);
      const registered = spawnSync(codex, ["mcp", "add", "cotal-e2e", "--", "cotal", "mcp", "--space", space, "--config", "gateway"], { cwd: root, env, encoding: "utf8" });
      check("real Codex records the installed stdio command without source paths", registered.status === 0, `${registered.stdout}\n${registered.stderr}`);
      const listed = spawnSync(codex, ["mcp", "list", "--json"], { cwd: root, env, encoding: "utf8" });
      const listing = listed.stdout ?? "";
      check("real Codex discoverability records the exact cotal MCP command and arguments", listed.status === 0 && listing.includes("cotal-e2e") && listing.includes("cotal") && listing.includes("gateway") && listing.includes(space), listing);

      const last = join(base, "codex-last-message.txt");
      const prompt = [
        "Validate the configured Cotal MCP server without using shell tools.",
        "Call cotal_identity_open with key codex-live, then call cotal_orientation.",
        `Then call cotal_send to channel general with text exactly ${nonce}.`,
        "Wait for each tool result. When all three calls have succeeded, reply with exactly COTAL_E2E_DONE.",
      ].join(" ");
      const run = spawnSync(codex, ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", root, "-o", last, prompt], {
        cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      const events = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
      if (run.error) throw new Error(`real Codex turn did not complete: ${run.error.message}\n${events.slice(-2_000)}`);
      const answer = existsSync(last) ? readFileSync(last, "utf8") : "";
      check("a real authenticated Codex turn calls the Cotal identity, orientation, and send tools", run.status === 0 && /cotal_identity_open/.test(events) && /cotal_orientation/.test(events) && /cotal_send/.test(events) && /COTAL_E2E_DONE/.test(answer), events.slice(-2_000));
      await waitFor("real Codex mesh nonce", () => witnessed, 30_000);
      check("the real mesh witness received the nonce from the real Codex MCP tool call", witnessed);
    } finally {
      await peer?.stop().catch(() => {});
      broker?.kill("SIGTERM");
      if (broker) await Promise.race([once(broker, "exit"), sleep(5_000)]);
      process.chdir(originalCwd);
      if (priorCotalHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = priorCotalHome;
    }
  }

  await cell("open");
  await cell("static");
  if (runRealCodex) await codexCell();
  check("every installed open/static MCP cell completed", passed === (runRealCodex ? 35 : 30), passed);
  console.log("MCP GATEWAY INSTALLED-ARTIFACT SMOKE OK ✅");
} finally {
  rmSync(base, { recursive: true, force: true });
}
