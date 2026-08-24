/**
 * Authenticated channel registration: a non-admin agent creates an in-ACL card through the
 * server-side registrar, cannot overwrite it, cannot register out of ACL, and cannot bypass the
 * mediator with a direct KV write.
 *
 * Run: pnpm smoke:channel-register:auth (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  aclBucket,
  channelBucket,
  createSpaceAuth,
  createSpaceStreams,
  CotalEndpoint,
  DEV_OWNER,
  isReachable,
  membersBucket,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  openChannelRegistry,
  principalKey,
  serverConfig,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra ?? ""); }
};

const space = `channel-register-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], {
    transport: { kind: "plaintext" },
    port: PORT,
    storeDir: join(dir, "js"),
  }),
);
const server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(server, dir);
const endpoints: CotalEndpoint[] = [];

try {
  for (let i = 0; i < 50 && !(await isReachable(SERVERS)); i++) await wait(100);
  if (!(await isReachable(SERVERS))) throw new Error("temporary auth broker did not start");

  // Minimal real broker substrate for this focused test. Avoid setupSpaceStreams' unrelated 4 GiB
  // artifact reservation so the registrar proof can run on a low-free-space workstation.
  const provisionerId = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisionerId, "provisioner");
  const setupNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provisionerCreds)),
    inboxPrefix: `_INBOX_${provisionerId.id}`,
  });
  await createSpaceStreams(await jetstreamManager(setupNc), space);
  const kvm = new Kvm(setupNc);
  await kvm.create(channelBucket(space));
  await kvm.create(membersBucket(space));
  await kvm.create(aclBucket(space));
  await setupNc.drain();

  const provisioner = new CotalEndpoint({
    space, servers: SERVERS, creds: provisionerCreds,
    card: { name: "provisioner", kind: "endpoint" },
    channels: [], consume: false, watchPresence: false, registerPresence: false,
  });
  endpoints.push(provisioner);
  await provisioner.start();

  const agentId = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const principal = principalKey(DEV_OWNER, agentId.id).key;
  await provisioner.reissueAcl(principal, lifecycleUid, ["project.>"]);
  const agentCreds = await mintCreds(auth, agentId, "agent", {
    lifecycleUid,
    subscribe: ["project.home"],
    allowSubscribe: ["project.>"],
    allowPublish: ["project.>"],
  });

  const deliveryId = newIdentity();
  const deliveryCreds = await mintCreds(auth, deliveryId, "delivery");
  const delivery = new CotalEndpoint({
    space, servers: SERVERS, creds: deliveryCreds,
    card: { id: deliveryId.id, name: "delivery", kind: "endpoint" },
    channels: [], consume: false, watchPresence: false, registerPresence: false,
  });
  endpoints.push(delivery);
  await delivery.start();
  await delivery.startPlane3(() => ["project.>"]);

  const agent = new CotalEndpoint({
    space, servers: SERVERS, creds: agentCreds, lifecycleUid,
    card: { id: agentId.id, name: "creator", kind: "agent" },
    channels: [], consume: false, watchPresence: false, registerPresence: false,
  });
  endpoints.push(agent);
  await agent.start();

  const first = await agent.registerChannel("project.cpn", { description: "CPN coordination" });
  check("non-admin agent registers an in-ACL channel", first.created, first);
  const second = await agent.registerChannel("project.cpn", { description: "overwrite attempt" });
  check("repeat registration is create-only", !second.created, second);

  const verifyNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(deliveryCreds)),
    inboxPrefix: `_INBOX_${deliveryId.id}`,
  });
  const deliveryRegistry = await openChannelRegistry(verifyNc, space);
  check(
    "existing card was not overwritten",
    (await deliveryRegistry.get("project.cpn"))?.json<{ description?: string }>().description === "CPN coordination",
  );
  await verifyNc.close();

  let outsideDenied = false;
  try { await agent.registerChannel("secret"); } catch { outsideDenied = true; }
  check("out-of-ACL channel is refused", outsideDenied);

  const rawNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(agentCreds)),
    inboxPrefix: `_INBOX_${agentId.id}`,
    maxReconnectAttempts: 0,
  });
  const rawKv = await openChannelRegistry(rawNc, space);
  let bypassDenied = false;
  try { await rawKv.put("project.bypass", new TextEncoder().encode("{}")); }
  catch { bypassDenied = true; }
  check("ordinary agent credential cannot write registry directly", bypassDenied);
  await rawNc.close();
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  for (const endpoint of endpoints.reverse()) {
    try { await endpoint.stop(); } catch { /* best-effort test cleanup */ }
  }
  server.kill("SIGKILL");
  await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(`CHANNEL-REGISTER AUTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
