/**
 * An authenticated agent's public-KV watches use lifecycle-pinned consumer names and delete them
 * on stop. This is the real CotalEndpoint entry path against a JWT-authenticated nats-server: the
 * broker grants no bucket-wide ordered-consumer create/delete fallback.
 *
 * Run: pnpm smoke:agent-watch-cleanup:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  CotalEndpoint,
  DEV_OWNER,
  agentKvWatchConsumerName,
  agentKvWatchDeliverySubject,
  channelBucket,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  presenceBucket,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  cells++;
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ FAIL: ${name}`, detail ?? "");
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const port = await pickFreePort();
const monitorPort = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `agent-watch-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const conf = join(dir, "server.conf");
const log = join(dir, "server.log");
writeFileSync(conf,
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") })
  + `\nhttp: "127.0.0.1:${monitorPort}"\n`);
const logFd = openSync(log, "w");
const broker = spawn("nats-server", ["-c", conf], { stdio: ["ignore", logFd, logFd] });
const releaseBroker = teardownOnSignal(broker, dir);

type Jsz = {
  account_details?: {
    stream_detail?: { name: string; consumer_detail?: { name: string }[] }[];
  }[];
};
const consumers = async (stream: string): Promise<string[]> => {
  const jsz = await (await fetch(`http://127.0.0.1:${monitorPort}/jsz?consumers=true&streams=true&accounts=true`)).json() as Jsz;
  const names: string[] = [];
  for (const account of jsz.account_details ?? []) {
    for (const candidate of account.stream_detail ?? []) {
      if (candidate.name === stream) for (const consumer of candidate.consumer_detail ?? []) names.push(consumer.name);
    }
  }
  return names.sort();
};

try {
  let up = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (broker.exitCode !== null) break;
    if (await isReachable(servers)) { up = true; break; }
    await wait(100);
  }
  if (!up) throw new Error(`fixture broker did not start: ${readFileSync(log, "utf8")}`);

  const provisionerIdentity = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisionerIdentity, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  const provisioner = new CotalEndpoint({
    space, servers, creds: provisionerCreds,
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
    card: { id: provisionerIdentity.id, name: "watch-provisioner", kind: "endpoint" },
  });
  await provisioner.start();
  const provisionerNc = await connect({
    servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(provisionerCreds)),
    inboxPrefix: `_INBOX_${provisionerIdentity.id}`,
    maxReconnectAttempts: 0,
  });
  const provisionerJsm = await jetstreamManager(provisionerNc);
  const proofChannel = "reconnect-proof";
  const channelKv = await new Kvm(provisionerNc).open(channelBucket(space));
  await channelKv.put(proofChannel, JSON.stringify({ replay: false, description: "retained across reconnect" }));
  const identity = newIdentity();
  const uid = mintLifecycleUid();
  const creds = await provisionAgent(provisioner, auth, identity, {
    subscribe: [], allowSubscribe: [], durableMembership: false, lifecycleUid: uid,
  });
  const endpointErrors: string[] = [];
  const endpoint = new CotalEndpoint({
    space,
    servers,
    creds,
    lifecycleUid: uid,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    watchChannels: true,
    // Presentation kind is deliberately `endpoint`: user-mode CLI observers use the agent
    // credential profile while staying invisible/non-agent in the roster. Their composition root
    // explicitly selects the exact watcher surface rather than pretending they are roster agents.
    lifecyclePinnedKvWatches: true,
    card: { id: identity.id, name: "watcher", kind: "endpoint" },
  });
  endpoint.on("error", (err: Error) => endpointErrors.push(err.message));
  let startError: unknown;
  try { await endpoint.start(); } catch (err) { startError = err; }
  check("real endpoint starts both lifecycle-pinned public-KV watchers", startError === undefined,
    startError instanceof Error ? startError.message : startError);
  if (startError) throw startError;

  const presenceStream = `KV_${presenceBucket(space)}`;
  const channelStream = `KV_${channelBucket(space)}`;
  const ownPresence = agentKvWatchConsumerName("presence", DEV_OWNER, identity.id, uid);
  const ownChannels = agentKvWatchConsumerName("channels", DEV_OWNER, identity.id, uid);
  const presenceLive = await consumers(presenceStream);
  const channelsLive = await consumers(channelStream);
  check("real endpoint creates exactly its lifecycle-pinned presence watcher",
    presenceLive.length === 1 && presenceLive[0] === ownPresence, presenceLive);
  check("real endpoint creates exactly its lifecycle-pinned channel watcher",
    channelsLive.length === 1 && channelsLive[0] === ownChannels, channelsLive);
  check("real endpoint creates no generated oc_* public-KV watcher",
    ![...presenceLive, ...channelsLive].some((name) => name.startsWith("oc_")), { presenceLive, channelsLive });
  const presenceInfo = await provisionerJsm.consumers.info(presenceStream, ownPresence);
  const channelInfo = await provisionerJsm.consumers.info(channelStream, ownChannels);
  check("trusted provisioner pins the presence watcher delivery rail",
    presenceInfo.config.deliver_subject === agentKvWatchDeliverySubject(space, "presence", DEV_OWNER, identity.id, uid),
    presenceInfo.config.deliver_subject);
  check("trusted provisioner pins the channel watcher delivery rail",
    channelInfo.config.deliver_subject === agentKvWatchDeliverySubject(space, "channels", DEV_OWNER, identity.id, uid),
    channelInfo.config.deliver_subject);
  check("both trusted watchers are ack-explicit LastPerSubject consumers",
    presenceInfo.config.ack_policy === AckPolicy.Explicit
      && channelInfo.config.ack_policy === AckPolicy.Explicit
      && presenceInfo.config.deliver_policy === DeliverPolicy.LastPerSubject
      && channelInfo.config.deliver_policy === DeliverPolicy.LastPerSubject,
    { presence: presenceInfo.config, channels: channelInfo.config });
  for (let attempt = 0; attempt < 20 && !endpoint.getChannelConfig(proofChannel); attempt++) await wait(25);
  check("channel watcher redelivers and materializes a snapshot published before provisioning",
    endpoint.getChannelConfig(proofChannel)?.description === "retained across reconnect",
    endpoint.getChannelConfig(proofChannel));
  let channelAckInfo = await provisionerJsm.consumers.info(channelStream, ownChannels);
  for (let attempt = 0; attempt < 20 && channelAckInfo.num_ack_pending !== 0; attempt++) {
    await wait(25);
    channelAckInfo = await provisionerJsm.consumers.info(channelStream, ownChannels);
  }
  check("channel watcher acknowledges the materialized update",
    channelAckInfo.num_ack_pending === 0, channelAckInfo.num_ack_pending);
  await provisionerNc.drain();
  check("watch startup has no broker permission error", endpointErrors.length === 0, endpointErrors);

  await endpoint.reconnect();
  check("in-process reconnect rebinds the provisioned watchers without CREATE authority",
    endpointErrors.length === 0
      && (await consumers(presenceStream)).includes(ownPresence)
      && (await consumers(channelStream)).includes(ownChannels), endpointErrors);
  check("acknowledged channel state remains materialized across reconnect",
    endpoint.getChannelConfig(proofChannel)?.description === "retained across reconnect",
    endpoint.getChannelConfig(proofChannel));

  // Same principal, different lifecycle: knowing the stable name is not authority to delete it.
  const peerUid = mintLifecycleUid();
  const peerName = agentKvWatchConsumerName("presence", DEV_OWNER, identity.id, peerUid);
  const nc = await connect({
    servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${identity.id}`,
    maxReconnectAttempts: 0,
  });
  let peerDenied = false;
  try {
    await nc.request(`$JS.API.CONSUMER.DELETE.${presenceStream}.${peerName}`, new Uint8Array(), { timeout: 500 });
  } catch (err) {
    peerDenied = /authorization|permission/i.test((err as Error).message);
  } finally {
    await nc.drain().catch(() => {});
  }
  check("same-principal peer lifecycle watcher delete is broker-denied", peerDenied);

  // A subject-pinned CREATE still leaves deliver_subject in the request BODY. Prove the current
  // grant cannot be used as a JetStream-mediated publish onto another principal's private inbox:
  // direct publish is denied first, then the same agent tries to recreate its exact watcher with
  // that foreign inbox as the push destination and write bytes through its permitted own KV key.
  const witness = newIdentity();
  const witnessCreds = await mintCreds(auth, witness, "observer");
  const witnessNc = await connect({
    servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(witnessCreds)),
    inboxPrefix: `_INBOX_${witness.id}`,
    maxReconnectAttempts: 0,
  });
  const foreignInbox = `_INBOX_${witness.id}.watch-exploit`;
  const foreignDeliveries: { subject: string; data: string }[] = [];
  const witnessSub = witnessNc.subscribe(foreignInbox, {
    callback: (_err, msg) => {
      foreignDeliveries.push({ subject: msg.subject, data: msg.string() });
      msg.respond(new TextEncoder().encode("witness"));
    },
  });
  await witnessNc.flush();

  const attackerNc = await connect({
    servers,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${identity.id}`,
    maxReconnectAttempts: 0,
  });
  let directDenied = false;
  try {
    await attackerNc.request(foreignInbox, new TextEncoder().encode("direct"), { timeout: 300 });
  } catch {
    directDenied = true;
  }
  await wait(50);
  check("agent direct publish to a foreign private inbox is broker-denied",
    directDenied && foreignDeliveries.length === 0, foreignDeliveries);

  const attackerJsm = await jetstreamManager(attackerNc);
  await attackerJsm.consumers.delete(presenceStream, ownPresence);
  let exploitCreateError: unknown;
  try {
    await attackerJsm.consumers.add(presenceStream, {
      name: ownPresence,
      durable_name: ownPresence,
      filter_subject: `$KV.${presenceBucket(space)}.>`,
      deliver_subject: foreignInbox,
      deliver_policy: DeliverPolicy.New,
      ack_policy: AckPolicy.None,
    });
  } catch (err) {
    exploitCreateError = err;
  }
  check("agent cannot create its exact watcher with a foreign deliver_subject",
    /authorization|permission/i.test(exploitCreateError instanceof Error ? exploitCreateError.message : ""),
    exploitCreateError instanceof Error ? exploitCreateError.message : exploitCreateError);

  if (!exploitCreateError) {
    await jetstream(attackerNc).publish(
      `$KV.${presenceBucket(space)}.${DEV_OWNER}.${identity.id}`,
      new TextEncoder().encode('{"watchExploit":true}'),
    );
    for (let attempt = 0; attempt < 20 && foreignDeliveries.length === 0; attempt++) await wait(25);
  }
  check("own-presence write cannot be broker-forwarded onto a foreign private inbox",
    foreignDeliveries.length === 0, foreignDeliveries);
  witnessSub.unsubscribe();
  await attackerNc.drain().catch(() => {});
  await witnessNc.drain().catch(() => {});

  let stopError: unknown;
  try { await endpoint.stop(); } catch (err) { stopError = err; }
  check("endpoint stop can delete both lifecycle-owned watchers", stopError === undefined,
    stopError instanceof Error ? stopError.message : stopError);
  let presenceAfter = await consumers(presenceStream);
  let channelsAfter = await consumers(channelStream);
  for (let attempt = 0; attempt < 20 && (presenceAfter.length || channelsAfter.length); attempt++) {
    await wait(50);
    presenceAfter = await consumers(presenceStream);
    channelsAfter = await consumers(channelStream);
  }
  check("stop leaves no presence watcher for the lifecycle", !presenceAfter.includes(ownPresence), presenceAfter);
  check("stop leaves no channel watcher for the lifecycle", !channelsAfter.includes(ownChannels), channelsAfter);

  // Missing lifecycle authority must fail before any stock ordered watch can be created. Cover both
  // selectors: the ordinary agent presentation and the explicit non-agent composition seam used by
  // user-mode CLI observers. A selector that checks UID too early silently falls back to kv.watch(),
  // generating oc_* and turning a configuration error into a broker authorization side effect.
  for (const mode of ["automatic agent", "explicit endpoint"] as const) {
    const missingErrors: string[] = [];
    const missing = new CotalEndpoint({
      space,
      servers,
      creds,
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: true,
      watchChannels: false,
      ...(mode === "explicit endpoint" ? { lifecyclePinnedKvWatches: true } : {}),
      card: { id: identity.id, name: `missing-${mode}`, kind: mode === "automatic agent" ? "agent" : "endpoint" },
    });
    missing.on("error", (err: Error) => missingErrors.push(err.message));
    let missingError = "";
    try { await missing.start(); } catch (err) { missingError = (err as Error).message; }
    await missing.stop().catch(() => {});
    check(`${mode} without lifecycleUid fails loud at the pinned watcher boundary`,
      /authenticated presence KV watch requires this endpoint's lifecycleUid/.test(missingError),
      { missingError, missingErrors });
    const afterMissing = await consumers(presenceStream);
    check(`${mode} without lifecycleUid creates no generated oc_* fallback`,
      !afterMissing.some((name) => name.startsWith("oc_")), afterMissing);
  }
  await provisioner.stop();
} finally {
  if (broker.exitCode === null) await killAndAwaitExit(broker, "SIGTERM");
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nAGENT-WATCH-CLEANUP SMOKE: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
