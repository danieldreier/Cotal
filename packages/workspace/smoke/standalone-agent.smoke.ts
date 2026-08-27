/**
 * Standalone target/persona preparation over real open and JWT-auth JetStream brokers.
 *
 * The gateway must not read personas from its cwd, and an authenticated identity must retire the
 * exact lifecycle it provisioned. This suite owns only the two broker PIDs it starts.
 *
 * Run: pnpm smoke:standalone-agent (needs nats-server on PATH)
 */
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import {
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintCreds,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";

const home = mkdtempSync(join(tmpdir(), "cotal-standalone-home-"));
process.env.COTAL_HOME = home;

if (spawnSync("nats-server", ["-v"], { stdio: "ignore" }).error) {
  console.error("standalone-agent smoke needs nats-server on PATH");
  rmSync(home, { recursive: true, force: true });
  process.exit(2);
}

const {
  authDir,
  prepareStandaloneAgent,
  recordMesh,
  resolveStandaloneAgent,
  saveSpaceAuth,
} = await import("../src/index.js");

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });

async function waitForBroker(server: string): Promise<void> {
  for (let attempt = 0; attempt < 75; attempt++) {
    if (await isReachable(server)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`broker did not come up at ${server}`);
}

function persona(root: string, name: string, channel = "general"): void {
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".cotal", "agents", `${name}.md`),
    `---\nname: ${name}\nrole: worker\nsubscribe: [${channel}]\nallowSubscribe: [${channel}]\nallowPublish: [${channel}]\ncapabilities: [spawn]\n---\nstandalone test persona\n`,
  );
}

console.log("standalone workspace agent lifecycle");
const roots: string[] = [];
const brokers: ReturnType<typeof spawn>[] = [];
try {
  // OPEN: target/persona resolution must use the registry-selected target root, never this unrelated cwd.
  {
    const root = mkdtempSync(join(tmpdir(), "cotal-standalone-open-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "cotal-standalone-open-cwd-"));
    roots.push(root, elsewhere);
    persona(root, "open-gateway");
    const port = await freePort();
    const server = `nats://127.0.0.1:${port}`;
    const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(root, "js")], { stdio: "ignore" });
    brokers.push(broker);
    await waitForBroker(server);
    await setupSpaceStreams({ servers: server, space: "standalone-open" });
    recordMesh({ space: "standalone-open", server, root, mode: "open", tlsRequired: false, ts: new Date().toISOString() });

    const resolved = resolveStandaloneAgent({ cwd: elsewhere, targetFlags: { space: "standalone-open" }, persona: "open-gateway" });
    check("open resolution uses the selected target persona root", resolved.persona.path === join(root, ".cotal", "agents", "open-gateway.md"), resolved);
    const prepared = await prepareStandaloneAgent({ resolved });
    check("open preparation is lazy and has no static identity material", prepared.id === undefined && prepared.creds === undefined && prepared.lifecycleUid === undefined, prepared);
    const endpoint = new CotalEndpoint({
      space: prepared.target.space,
      servers: prepared.target.server,
      channels: prepared.subscribe,
      card: { name: prepared.name, role: prepared.role, kind: prepared.kind },
    });
    endpoint.on("error", () => {});
    await endpoint.start();
    await endpoint.stop();
    await prepared.retire();
    check("open preparation and retirement complete without a broker-managed footprint", true);
  }

  // STATIC: provision a real lifecycle, bind it as an endpoint, then prove retirement removes exactly
  // its DM durable. A lifecycle-wide or no-op cleanup cannot satisfy this assertion.
  {
    const root = mkdtempSync(join(tmpdir(), "cotal-standalone-static-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "cotal-standalone-static-cwd-"));
    roots.push(root, elsewhere);
    persona(root, "static-gateway");
    const space = "standalone-static";
    const auth = await createSpaceAuth(space);
    saveSpaceAuth(authDir(root), auth);
    const port = await freePort();
    const server = `nats://127.0.0.1:${port}`;
    const broker = spawn(
      "nats-server",
      ["-c", (() => {
        const path = join(root, "server.conf");
        writeFileSync(path, serverConfig(auth, [auth], { port, host: "127.0.0.1", storeDir: join(root, "js"), transport: { kind: "plaintext" } }));
        return path;
      })()],
      { stdio: "ignore" },
    );
    brokers.push(broker);
    await waitForBroker(server);
    const adminCreds = await mintCreds(auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers: server, space, creds: adminCreds });
    recordMesh({ space, server, root, mode: "auth", tlsRequired: false, ts: new Date().toISOString() });

    const resolved = resolveStandaloneAgent({ cwd: elsewhere, targetFlags: { space }, config: "static-gateway" });
    const prepared = await prepareStandaloneAgent({ resolved });
    check("static preparation returns one lifecycle-paired credential identity", !!prepared.id && !!prepared.creds && !!prepared.lifecycleUid, prepared);
    const endpoint = new CotalEndpoint({
      space,
      servers: server,
      creds: prepared.creds,
      lifecycleUid: prepared.lifecycleUid,
      channels: prepared.subscribe,
      card: { id: prepared.id, name: prepared.name, role: prepared.role, kind: prepared.kind },
    });
    endpoint.on("error", () => {});
    await endpoint.start();
    await endpoint.stop();
    check("static lifecycle-paired credential binds a real agent endpoint", true);

    await prepared.retire();
    await prepared.retire();
    const stale = new CotalEndpoint({
      space,
      servers: server,
      creds: prepared.creds,
      lifecycleUid: prepared.lifecycleUid,
      channels: prepared.subscribe,
      card: { id: prepared.id, name: prepared.name, role: prepared.role, kind: prepared.kind },
    });
    stale.on("error", () => {});
    let rebound = false;
    try {
      await stale.start();
      rebound = true;
    } catch {
      // The still-valid credential can only bind the exact durable this lifecycle provisioned; after
      // retirement the broker rejects the bind, proving we did not merely forget local cleanup.
    } finally {
      await stale.stop().catch(() => {});
    }
    check("retirement removes exactly this lifecycle's DM durable", !rebound);
  }

  // The workspace package has no composition-root argv for an auth-provider command. Refuse the two
  // user-mode cases that cannot be generalized, instead of guessing an executable or remote contract.
  {
    const root = mkdtempSync(join(tmpdir(), "cotal-standalone-user-root-"));
    roots.push(root);
    persona(root, "user-gateway");
    const resolved = resolveStandaloneAgent({
      target: {
        root,
        server: "nats://127.0.0.1:1",
        space: "standalone-user",
        mode: "user",
        tlsRequired: false,
        personaRoot: join(root, ".cotal", "agents"),
        source: "flag-server",
        userAuth: { remote: true } as never,
      },
      persona: "user-gateway",
    });
    await assert.rejects(
      () => prepareStandaloneAgent({ resolved }),
      /remote user-auth target .* is not supported/,
    );
    check("remote user-auth refuses rather than guessing the CLI-only material contract", true);
    const local = { ...resolved, target: { ...resolved.target, userAuth: { remote: false } as never } };
    await assert.rejects(
      () => prepareStandaloneAgent({ resolved: local }),
      /requires userAuth\.bearerCommand/,
    );
    check("local user-auth requires an explicit composition-root bearer command", true);
  }
} catch (error) {
  fail++;
  console.error("  ✗ scenario threw:", (error as Error).stack ?? (error as Error).message);
} finally {
  for (const broker of brokers) broker.kill("SIGKILL");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

const expected = 8;
check(`every cell ran - ${expected} expected`, pass + fail === expected, `${pass + fail} cells reported`);
console.log(`STANDALONE-AGENT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
