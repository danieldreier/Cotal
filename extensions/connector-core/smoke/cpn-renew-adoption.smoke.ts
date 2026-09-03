/**
 * CPN credential adoption on a REAL broker (no test runner, no mocks).
 *
 * Validates that a MeshAgent built on a CPN credential cell adopts a re-signed same-nkey
 * credential, swaps its LIVE connection onto it, survives its original credential's expiry, refuses
 * one that names a different nkey, and — when an adoption fails at either stage — never leaves the
 * cell and the endpoint's committed credential disagreeing.
 *
 * Nothing here is stood in for. A real `nats-server` under JWT auth, real `createSpaceAuth` /
 * `provisionAgent` grants (the same call the CPN issuer makes when it re-signs, so the computed read
 * ACL is production's rather than a hand-rolled mint's), a real `MeshAgent`, a real TCP forwarder
 * carrying real NATS bytes in front of the real broker, and the shipped `adoptCpnCreds` — there is
 * no test-only seam in `src/`.
 *
 * Measured runtime 23-29 s over five runs (agent A's 120 s lease bounds the wire-swap window but is
 * never waited out; agent B's 20 s lease is what the wall clock is, because crossing an expiry
 * means waiting for one — putting that crossing on agent A's lease would have cost 125 s). Gated
 * in `bin/smoke/ci-suites.txt`.
 *
 * Run: pnpm smoke:cpn-renew-adoption   (needs `nats-server` on PATH)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  credsClaims,
  idFromCreds,
  identityFromCreds,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  type CotalMessage,
} from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { CpnAdoptError, resolveCpnRenewal } from "../src/cpn-renew.js";
import type { AgentConfig } from "../src/config.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const BROKER_PORT = await pickFreePort();
const PROXY_PORT = await pickFreePort();
const brokerUrl = `nats://127.0.0.1:${BROKER_PORT}`;
const servers = `nats://127.0.0.1:${PROXY_PORT}`; // the AGENT talks through the proxy
const space = "cpnrenew-adopt";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(stepMs);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let checks = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  checks++;
  console.log(`  ✓ ${name}`);
};

// A transparent TCP forwarder in front of the broker. `refuseAt` is a ONE-SHOT ordinal, not a mode:
// arm it, and the Nth new connection from that moment is destroyed and every later one is forwarded
// again. That shape is what makes the reconnect failure deterministic rather than a race —
// adoptCpnCreds opens exactly THREE connections in a fixed order, and the endpoint's background
// reestablishLoop cannot start until the last one has already been refused:
//
//   1. probeConnect's `tcpDialable` reachability gate (endpoint.ts opens a socket it owns BEFORE
//      handing the address to nats.js, so the preflight costs TWO connections, not one);
//   2. probeConnect's real nats.js connect — the preflight proof itself;
//   3. connectAndBind inside ep.reconnect(), which has no pre-dial gate of its own.
//
// Refusing #3 is what makes reloadCreds succeed and the wire swap fail, which is the only state the
// D-k rollback can be observed in.
const RECONNECT_CONNECTION_ORDINAL = 3;
let conns = 0;
let refuseAt = -1;
const live = new Set<Socket>();
const proxy = createServer((down) => {
  live.add(down);
  down.on("close", () => live.delete(down));
  conns++;
  if (conns === refuseAt) {
    refuseAt = -1;
    down.destroy();
    return;
  }
  const up = connect(BROKER_PORT, "127.0.0.1");
  live.add(up);
  up.on("close", () => live.delete(up));
  down.on("error", () => up.destroy());
  up.on("error", () => down.destroy());
  down.pipe(up);
  up.pipe(down);
});
proxy.on("error", () => {});
const armRefusalOfTheReconnect = () => {
  conns = 0;
  refuseAt = RECONNECT_CONNECTION_ORDINAL;
};

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: BROKER_PORT, storeDir: join(dir, "js") }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const roots: string[] = [];
/** The launch layout `cotal-cpn-claude` writes, so `credsPath` parses as a generation. */
const writeGeneration = (tag: string, creds: string): string => {
  const root = mkdtempSync(join(tmpdir(), `cpn-renew-${tag}-`));
  roots.push(root);
  const gen = join(root, "generations", `req-${tag}`);
  mkdirSync(gen, { recursive: true });
  const path = join(gen, "cotal.creds");
  writeFileSync(path, creds, { mode: 0o600 });
  return path;
};
/** cpnRenewal is passed EXPLICITLY: this suite sets no environment variable, so nothing it builds
 *  can arm anything else in the process. The launcher URL is unreachable on purpose — Task 2 never
 *  calls the launcher, it drives `adoptCpnCreds` directly. */
const renewalFor = (name: string, credsPath: string, lifecycleUid: string) =>
  resolveCpnRenewal(
    { name, credsPath, lifecycleUid },
    { COTAL_CPN_LAUNCHER_URL: "http://127.0.0.1:1", COTAL_AGENT_KIND: "claude-code" },
  )!;

let agentA: MeshAgent | undefined;
let agentB: MeshAgent | undefined;
let watcher: CotalEndpoint | undefined;
let mgr: CotalEndpoint | undefined;

try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(brokerUrl)) break;
    await sleep(200);
  }
  assert.ok(await isReachable(brokerUrl), "the auth broker never came up - this suite has no subject");
  await new Promise<void>((r) => proxy.listen(PROXY_PORT, "127.0.0.1", () => r()));

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: brokerUrl, space, creds: mgrCreds });
  mgr = new CotalEndpoint({
    space,
    servers: brokerUrl,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
  });
  mgr.on("error", () => {});
  await mgr.start();

  const acl = { subscribe: ["coordination"], allowSubscribe: ["coordination"], allowPublish: ["coordination"] };

  // A scoped receiver, direct to the broker: the round-trip oracle for checks 11 and 12.
  const watcherId = newIdentity();
  const watcherUid = mintLifecycleUid();
  const watcherCreds = await provisionAgent(mgr, auth, watcherId, { ...acl, role: "helper", lifecycleUid: watcherUid });
  const heard: string[] = [];
  watcher = new CotalEndpoint({
    space,
    servers: brokerUrl,
    creds: watcherCreds,
    card: { id: watcherId.id, name: "watcher", kind: "agent" },
    channels: ["coordination"],
    lifecycleUid: watcherUid,
  });
  watcher.on("error", () => {});
  watcher.on("message", (m: CotalMessage) => {
    for (const p of m.parts) if (p.kind === "text") heard.push(p.text);
  });
  await watcher.start();

  // ── Agent A: a 120 s lease. Long enough that neither the endpoint's own 75% timer nor the
  // broker's expiry-close can substitute for a wire swap inside the 20 s window check 5 measures.
  const LEASE_A = 120;
  const idA = newIdentity();
  const uidA = mintLifecycleUid();
  const genA1 = await provisionAgent(mgr, auth, idA, { ...acl, role: "helper", lifecycleUid: uidA, expiresInSeconds: LEASE_A });
  const credsPathA = writeGeneration("a1", genA1);

  const cfgA: AgentConfig = {
    space,
    name: "laptop-claude-helper-1",
    role: "helper",
    servers,
    creds: genA1,
    credsPath: credsPathA,
    lifecycleUid: uidA,
    id: idA.id,
    kind: "agent",
    tls: false,
    ...acl,
    cpnRenewal: renewalFor("laptop-claude-helper-1", credsPathA, uidA),
  };
  agentA = new MeshAgent(cfgA);
  const drops: number[] = [];
  agentA.ep.on("connection", (e: { connected: boolean }) => {
    if (!e.connected) drops.push(Date.now());
  });
  agentA.on("error", () => {});
  agentA.start();

  // ── 1) the subject check: without a connection nothing below means anything.
  check("the agent connects on the launch credential", await until(() => agentA!.connected, 10_000));

  // ── 2) `MeshAgent.id` is the endpoint's CARD id, which is the principal dot-form
  // `<owner>.<actor>` (endpoint.ts builds it from principalKey); the nkey is the ACTOR half.
  check(
    "the connection's nkey is the launch credential's nkey",
    agentA.ep.card.actor === idA.id && agentA.id === `${agentA.ep.card.owner}.${idA.id}`,
    { cardId: agentA.id, actor: agentA.ep.card.actor, want: idA.id },
  );

  // ── 3) After check 1 deliberately: reloadCreds runs a real preflight, commits currentCreds and
  // re-arms the 75% timer, so it is not a read-only probe.
  let reloadedIdentity = "";
  let reloadError = "";
  try {
    reloadedIdentity = (await agentA.ep.reloadCreds()).identity;
  } catch (e) {
    reloadError = (e as Error).message;
  }
  check(
    "the endpoint was built on a creds SOURCE, not a static string",
    reloadError === "" && reloadedIdentity === idA.id,
    { reloadError, reloadedIdentity },
  );

  // ── 4) The re-sign the issuer performs, done locally: same nkey, same lifecycle uid, longer lease.
  const genA2 = await provisionAgent(mgr, auth, identityFromCreds(genA1), {
    ...acl,
    role: "helper",
    lifecycleUid: uidA,
    expiresInSeconds: LEASE_A * 4,
  });
  const dropsBefore = drops.length;
  const t0 = Date.now();
  const windowA2 = await agentA.adoptCpnCreds(genA2);
  check(
    "adoption reports the same identity and a later expiry",
    windowA2.identity === idA.id && windowA2.exp! > credsClaims(genA1).exp!,
    { window: windowA2, previousExp: credsClaims(genA1).exp },
  );

  // ── 5) The wire-swap oracle: ep.reconnect() tears the connection down and rebuilds it, emitting
  // connection:{connected:false} then a fresh bind. With a 120 s lease nothing else drops here.
  const swapped = await until(() => drops.length > dropsBefore && agentA!.connected, 20_000);
  check(
    "adoption swaps the LIVE connection within 20 seconds",
    swapped && drops[dropsBefore] - t0 <= 20_000,
    { drops: drops.length, dropsBefore, sinceAdopt: drops[dropsBefore] !== undefined ? drops[dropsBefore] - t0 : null },
  );

  // ── 6)
  check(
    "the nkey is unchanged across the renewal",
    idFromCreds(genA1) === idFromCreds(genA2) && agentA.ep.card.actor === idA.id,
    { a1: idFromCreds(genA1), a2: idFromCreds(genA2), live: agentA.ep.card.actor },
  );

  // ── 7) The CELL's pin, proven to fire BEFORE the endpoint's: a plain Error, not a CpnAdoptError,
  // means nothing reached reloadCreds.
  const alien = await provisionAgent(mgr, auth, newIdentity(), {
    ...acl,
    role: "helper",
    lifecycleUid: mintLifecycleUid(),
    expiresInSeconds: LEASE_A,
  });
  const alienErr = await agentA.adoptCpnCreds(alien).then(() => undefined, (e) => e as Error);
  check(
    "a credential naming a DIFFERENT nkey is refused by the cell before anything moves",
    alienErr !== undefined &&
      !(alienErr instanceof CpnAdoptError) &&
      /may not swap this session's nkey/.test(alienErr.message) &&
      agentA.cpnCredsWindow()!.exp === credsClaims(genA2).exp,
    { message: alienErr?.message, cellExp: agentA.cpnCredsWindow()?.exp, want: credsClaims(genA2).exp },
  );

  // ── 8) The ENDPOINT's pin, so check 7 cannot be passing because the endpoint happened to catch it.
  const otherId = newIdentity();
  const otherCreds = await mintCreds(auth, otherId, "agent", {
    lifecycleUid: mintLifecycleUid(),
    expiresInSeconds: LEASE_A,
    allowSubscribe: ["coordination"],
    allowPublish: ["coordination"],
  });
  let sourceSwapErr = "";
  try {
    const swappedEp = new CotalEndpoint({
      space,
      servers: brokerUrl,
      creds: () => Promise.resolve(otherCreds),
      card: { id: idA.id, name: "swapped", kind: "endpoint" },
      consume: false,
      watchChannels: false,
      watchPresence: false,
      registerPresence: false,
    });
    swappedEp.on("error", () => {});
    await swappedEp.start();
    await swappedEp.stop();
  } catch (e) {
    sourceSwapErr = (e as Error).message;
  }
  check(
    "a source returning a DIFFERENT identity fails loud at the endpoint too",
    /may not swap the connection's nkey/.test(sourceSwapErr),
    { sourceSwapErr },
  );

  // ── 9) Same nkey, FOREIGN account: both nkey pins pass, the preflight fails, so reloadCreds
  // throws before the commit and nothing may be left in the cell.
  const otherAuth = await createSpaceAuth(space);
  const foreign = await mintCreds(otherAuth, identityFromCreds(genA2), "agent", {
    lifecycleUid: uidA,
    expiresInSeconds: 600,
    allowSubscribe: ["coordination"],
    allowPublish: ["coordination"],
  });
  const foreignErr = await agentA.adoptCpnCreds(foreign).then(() => undefined, (e) => e as Error);
  let stillReloads = "";
  try {
    await agentA.ep.reloadCreds();
  } catch (e) {
    stillReloads = (e as Error).message;
  }
  check(
    "a credential the broker refuses leaves the session on the previous credential",
    foreignErr instanceof CpnAdoptError &&
      foreignErr.stage === "reload" &&
      foreignErr.leftOn === "previous" &&
      agentA.cpnCredsWindow()!.exp === credsClaims(genA2).exp &&
      stillReloads === "",
    {
      stage: (foreignErr as CpnAdoptError | undefined)?.stage,
      leftOn: (foreignErr as CpnAdoptError | undefined)?.leftOn,
      message: foreignErr?.message,
      cellExp: agentA.cpnCredsWindow()?.exp,
      wantExp: credsClaims(genA2).exp,
      foreignExp: credsClaims(foreign).exp,
      stillReloads,
    },
  );

  // ── 10) The rollback both ways round: the cell AND the endpoint's committed credential.
  const genA3 = await provisionAgent(mgr, auth, identityFromCreds(genA2), {
    ...acl,
    role: "helper",
    lifecycleUid: uidA,
    expiresInSeconds: LEASE_A * 8,
  });
  armRefusalOfTheReconnect();
  const swapErr = await agentA.adoptCpnCreds(genA3).then(() => undefined, (e) => e as CpnAdoptError);
  const cellNow = agentA.cpnCredsWindow(); // synchronous — read before anything else awaits
  check(
    "a failed wire swap puts BOTH the cell and the endpoint back on the previous credential",
    swapErr instanceof CpnAdoptError &&
      swapErr.stage === "reconnect" &&
      swapErr.leftOn === "previous" &&
      swapErr.window?.exp === credsClaims(genA2).exp &&
      cellNow!.exp === credsClaims(genA2).exp,
    {
      stage: swapErr?.stage,
      leftOn: swapErr?.leftOn,
      endpointExp: swapErr?.window?.exp,
      cellExp: cellNow?.exp,
      wantExp: credsClaims(genA2).exp,
      a3Exp: credsClaims(genA3).exp,
      message: swapErr?.message,
    },
  );

  // ── 11) The refusal was one-shot, so the session must come back and carry real traffic.
  const backUp = await until(() => agentA!.connected, 20_000);
  let delivered = false;
  if (backUp) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !delivered) {
      try {
        await agentA.send("post-rollback", "coordination");
      } catch {
        /* still rebuilding; retry */
      }
      delivered = await until(() => heard.includes("post-rollback"), 2_000, 100);
    }
  }
  check("the session recovers and round-trips after the failed swap", backUp && delivered, { backUp, heard: heard.length });

  // ── 12) Concurrent adoption is one serialized state machine. The first wire swap is refused;
  // the second must wait for its rollback, then commit on top of the restored previous credential.
  const genA4 = await provisionAgent(mgr, auth, identityFromCreds(genA2), { ...acl, role: "helper", lifecycleUid: uidA, expiresInSeconds: LEASE_A * 8 });
  const genA5 = await provisionAgent(mgr, auth, identityFromCreds(genA2), { ...acl, role: "helper", lifecycleUid: uidA, expiresInSeconds: LEASE_A * 10 });
  armRefusalOfTheReconnect();
  const concurrent = await Promise.allSettled([agentA.adoptCpnCreds(genA4), agentA.adoptCpnCreds(genA5)]);
  const finalCell = agentA.cpnCredsWindow();
  check(
    "overlapping adoption leaves the cell and endpoint on the later committed credential",
    concurrent[0]?.status === "rejected" && concurrent[1]?.status === "fulfilled" &&
      finalCell?.exp === credsClaims(genA5).exp,
    { first: concurrent[0]?.status, second: concurrent[1]?.status, cellExp: finalCell?.exp },
  );

  // ── 13) A SECOND agent, direct to the broker, on a deliberately tiny lease: cross the original
  // credential's own expiry on the renewed one. Agent B exists so this wait is 25 s, not 125 s.
  const LEASE_B = 20;
  const idB = newIdentity();
  const uidB = mintLifecycleUid();
  const genB1 = await provisionAgent(mgr, auth, idB, { ...acl, role: "helper", lifecycleUid: uidB, expiresInSeconds: LEASE_B });
  const credsPathB = writeGeneration("b1", genB1);
  agentB = new MeshAgent({
    space,
    name: "laptop-claude-helper-2",
    role: "helper",
    servers: brokerUrl,
    creds: genB1,
    credsPath: credsPathB,
    lifecycleUid: uidB,
    id: idB.id,
    kind: "agent",
    tls: false,
    ...acl,
    cpnRenewal: renewalFor("laptop-claude-helper-2", credsPathB, uidB),
  });
  agentB.on("error", () => {});
  agentB.start();
  const bUp = await until(() => agentB!.connected, 10_000);
  const genB2 = await provisionAgent(mgr, auth, identityFromCreds(genB1), {
    ...acl,
    role: "helper",
    lifecycleUid: uidB,
    expiresInSeconds: 240,
  });
  const windowB2 = bUp ? await agentB.adoptCpnCreds(genB2) : undefined;

  const expB1Ms = credsClaims(genB1).exp! * 1000;
  await sleep(Math.max(0, expB1Ms + 1500 - Date.now()));
  let statusAfterExpiry = false;
  let roundTripAfterExpiry = false;
  const bDeadline = Date.now() + 15_000;
  while (Date.now() < bDeadline && !roundTripAfterExpiry) {
    try {
      await agentB.setStatus("working", "post-expiry");
      statusAfterExpiry = true;
      await agentB.send("post-expiry", "coordination");
    } catch {
      /* still re-establishing; retry until the deadline */
    }
    roundTripAfterExpiry = await until(() => heard.includes("post-expiry"), 2_000, 100);
  }
  check(
    "a session crosses its ORIGINAL expiry and still works",
    bUp && windowB2?.identity === idB.id && Date.now() > expB1Ms && statusAfterExpiry && roundTripAfterExpiry,
    {
      bUp,
      adopted: windowB2?.exp,
      originalExp: credsClaims(genB1).exp,
      pastExpiry: Date.now() > expB1Ms,
      statusAfterExpiry,
      roundTripAfterExpiry,
    },
  );

  assert.ok(checks === 13, `cpn-renew-adoption ran ${checks} checks, expected 13`);
  console.log(`\nCPN RENEW ADOPTION SMOKE OK ✅  (${checks} checks)`);
} catch (err) {
  // The banner has to carry the SAME marker on both outcomes. This suite is fail-fast (every check
  // is an assert), so its success line is by construction the one line a failing run never reaches;
  // a mutation proof keyed on a success-only marker discards exactly the evidence it exists to
  // protect. Rethrown, so the failure is still the process's exit status.
  console.error(`\nCPN RENEW ADOPTION SMOKE FAILED ❌  (after ${checks} checks)`);
  throw err;
} finally {
  await agentA?.stop().catch(() => {});
  await agentB?.stop().catch(() => {});
  await watcher?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  for (const s of live) s.destroy();
  await new Promise<void>((r) => proxy.close(() => r()));
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(0);
