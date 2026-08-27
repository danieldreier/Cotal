import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import {
  CotalEndpoint,
  agentFilePath,
  assertValidName,
  deprovisionAgent,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  provisionAgent,
  provisionAgentDurables,
  resolveAuthProvider,
  type AgentDef,
  type EndpointKind,
} from "@cotal-ai/core";
import {
  agentLifecycleActorTokenKey,
  agentLifecycleSecretFilePaths,
  agentLifecycleSentinelCredsKey,
  authDir,
  getSpaceAuth,
  materializeSecretToFile,
  userAuthStateDir,
} from "./auth-paths.js";
import { defaultPersonaRef } from "./default-agent.js";
import { resolveMeshTarget, type MeshTarget, type ResolveFlags } from "./mesh-target.js";
import { workspaceSecretStore } from "./secret-store-fs.js";

/** The target-aware persona selected for a standalone local agent. */
export interface StandalonePersona {
  /** The winning config/positional/default reference, before it was resolved to a path. */
  ref: string;
  path: string;
  def: AgentDef;
}

/**
 * Resolve a standalone agent without creating an identity or touching the broker. This is safe for
 * completion and command validation; {@link prepareStandaloneAgent} performs the lazy provisioning.
 */
export function resolveStandaloneAgent(opts: {
  cwd?: string;
  target?: MeshTarget;
  targetFlags?: ResolveFlags;
  /** Explicit file/persona reference; wins over `persona` and the configured default. */
  config?: string;
  persona?: string;
  env?: NodeJS.ProcessEnv;
} = {}): { target: MeshTarget; persona: StandalonePersona } {
  if (opts.target && opts.targetFlags)
    throw new Error("resolveStandaloneAgent: pass either target or targetFlags, not both");
  const target = opts.target ?? resolveMeshTarget(opts.cwd ?? process.cwd(), opts.targetFlags);
  const ref = opts.config ?? opts.persona ?? defaultPersonaRef("default", opts.env);
  const path = agentFilePath(target.root, ref);
  return { target, persona: { ref, path, def: loadAgentFile(path) } };
}

export interface StandaloneUserBearerInput {
  /** The registered provider command name. The caller chooses how its composition invokes it. */
  providerCommand: string;
  dir: string;
  space: string;
  owner: string;
  actor: string;
  tokenFile: string;
  healthFile: string;
}

/**
 * User-mode bearer commands belong to a composition root: workspace owns the provisioned material,
 * while the host decides how it invokes a registered provider command. The returned argv is run once
 * before preparation succeeds, matching foreground spawn's dead-auth-chain gate.
 */
export interface StandaloneUserAuthOptions {
  bearerCommand(input: StandaloneUserBearerInput): readonly string[];
}

export interface PrepareStandaloneAgentOptions {
  /** Resolved target/persona. Omitting this makes preparation resolve them first, without provisioning. */
  resolved?: { target: MeshTarget; persona: StandalonePersona };
  cwd?: string;
  targetFlags?: ResolveFlags;
  config?: string;
  persona?: string;
  env?: NodeJS.ProcessEnv;
  name?: string;
  role?: string;
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
  capabilities?: string[];
  /** Explicitly opt out of the delivery-backed durable membership. */
  liveOnly?: boolean;
  /** Required only for a local user-auth target. Remote user provisioning is intentionally unsupported here. */
  userAuth?: StandaloneUserAuthOptions;
}

export interface PreparedStandaloneAgent {
  target: MeshTarget;
  persona: StandalonePersona;
  name: string;
  role?: string;
  kind: EndpointKind;
  description?: string;
  tags?: string[];
  meta?: Record<string, string>;
  capabilities?: string[];
  subscribe: string[];
  allowSubscribe: string[];
  allowPublish: string[];
  quiet?: string[];
  muted?: string[];
  /** Present only for static-auth provisioned identities. */
  id?: string;
  /** Present only for authenticated identities; open endpoints mint their own lifecycle on connect. */
  lifecycleUid?: string;
  /** Static credential contents, held in memory for the caller's connector-neutral configuration. */
  creds?: string;
  /** User-mode runtime material. The token remains in a lifecycle-keyed private file for bearer refresh. */
  userAuth?: { owner: string; actor: string; sentinelCreds: string; bearerCmd: string[] };
  /** Idempotently retire exactly this prepared incarnation. */
  retire(): Promise<void>;
}

function provisioner(target: MeshTarget, creds: string, name: string): CotalEndpoint {
  const ep = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name, role: "provisioner", kind: "endpoint" },
  });
  // The caller receives failures from start/provision directly; this prevents an unhandled EventEmitter
  // error from masking that same failure as a process crash.
  ep.on("error", () => {});
  return ep;
}

function checkedBearerCommand(command: readonly string[]): string[] {
  if (!command.length || command.some((part) => typeof part !== "string" || !part.length))
    throw new Error("prepareStandaloneAgent: userAuth.bearerCommand must return a non-empty argv of non-empty strings");
  return [...command];
}

async function verifyBearerCommand(command: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command[0], command.slice(1), { timeout: 30_000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}

async function retireStaticLifecycle(target: MeshTarget, id: string, lifecycleUid: string): Promise<void> {
  if (!target.auth) throw new Error(`retireStaticLifecycle: auth target "${target.space}" has no usable trust material`);
  const deprovisioner = await mintCreds(target.auth, newIdentity(), "deprovisioner", {
    deprovisionTarget: { principal: id, lifecycleUid },
  });
  await deprovisionAgent({
    servers: target.server,
    space: target.space,
    targetId: id,
    lifecycleUid,
    creds: deprovisioner,
  });
}

/**
 * Prepare one standalone agent identity lazily. Open targets deliberately allocate no static state;
 * static and local user-auth targets mint a fresh lifecycle and return cleanup that tears down only
 * that lifecycle's broker and local footprint.
 */
export async function prepareStandaloneAgent(opts: PrepareStandaloneAgentOptions = {}): Promise<PreparedStandaloneAgent> {
  const resolved = opts.resolved ?? resolveStandaloneAgent(opts);
  const { target, persona } = resolved;
  const def = persona.def;
  const name = opts.name ?? def.name;
  assertValidName(name);
  const role = opts.role ?? def.role;
  const subscribe = opts.subscribe ?? def.subscribe ?? [];
  const allowSubscribe = opts.allowSubscribe ?? def.allowSubscribe ?? subscribe;
  const allowPublish = opts.allowPublish ?? def.allowPublish ?? [];
  const capabilities = opts.capabilities ?? def.capabilities;
  const base = {
    target,
    persona,
    name,
    ...(role ? { role } : {}),
    kind: def.kind ?? "agent" as EndpointKind,
    ...(def.description ? { description: def.description } : {}),
    ...(def.tags ? { tags: def.tags } : {}),
    ...(def.meta ? { meta: def.meta } : {}),
    ...(capabilities ? { capabilities } : {}),
    subscribe,
    allowSubscribe,
    allowPublish,
    ...(def.quiet ? { quiet: def.quiet } : {}),
    ...(def.muted ? { muted: def.muted } : {}),
  };

  if (target.mode === "open") return { ...base, retire: async () => {} };

  if (target.mode === "auth") {
    if (!target.auth)
      throw new Error(`prepareStandaloneAgent: auth target "${target.space}" has no usable trust material`);
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const ep = provisioner(target, await mintCreds(target.auth, newIdentity(), "provisioner"), "standalone-provisioner");
    let creds: string;
    try {
      await ep.start();
      creds = await provisionAgent(ep, target.auth, identity, {
        subscribe,
        allowSubscribe,
        allowPublish,
        role,
        capabilities,
        ...(opts.liveOnly ? { durableMembership: false } : {}),
        lifecycleUid,
      });
    } catch (error) {
      // provisionAgent may have created some of the lifecycle-keyed footprint before a later broker
      // operation fails. Tear down by the exact uid before surfacing the original failure.
      try {
        await retireStaticLifecycle(target, identity.id, lifecycleUid);
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          `prepareStandaloneAgent: static provisioning failed and lifecycle ${lifecycleUid} could not be retired`,
        );
      }
      throw error;
    } finally {
      await ep.stop().catch(() => {});
    }
    return {
      ...base,
      id: identity.id,
      lifecycleUid,
      creds: creds!,
      retire: retirement(() => retireStaticLifecycle(target, identity.id, lifecycleUid)),
    };
  }

  if (target.userAuth?.remote)
    throw new Error(
      `prepareStandaloneAgent: remote user-auth target "${target.space}" is not supported because its remote provisioning material is CLI-specific; run the gateway where the mesh owns its provisioning authority`,
    );
  if (!opts.userAuth)
    throw new Error(
      `prepareStandaloneAgent: local user-auth target "${target.space}" requires userAuth.bearerCommand; workspace cannot infer a composition root's provider-command argv`,
    );

  const store = workspaceSecretStore(target.root);
  const dir = userAuthStateDir(target.root, target.space);
  const provider = resolveAuthProvider();
  const owner = await provider.ownerForLogin({ store, dir, space: target.space });
  const infra = await getSpaceAuth(store, target.space);
  if (!infra)
    throw new Error(
      `prepareStandaloneAgent: user-auth target "${target.space}" has no trust record under ${authDir(target.root)}; re-run its user-auth setup before provisioning an agent`,
    );
  const lifecycleUid = mintLifecycleUid();
  const paths = agentLifecycleSecretFilePaths(target.root, name, lifecycleUid);
  const principal = principalKey(owner, name).key;
  let grantCreated = false;
  const cleanup = retirement(async () => {
    const failures: unknown[] = [];
    await provider.revokeAgent({ dir, owner, actor: name }).catch((error) => failures.push(error));
    await store.delete(agentLifecycleActorTokenKey(name, lifecycleUid)).catch((error) => failures.push(error));
    await store.delete(agentLifecycleSentinelCredsKey(name, lifecycleUid)).catch((error) => failures.push(error));
    rmSync(paths.actorToken, { force: true });
    rmSync(paths.sentinelCreds, { force: true });
    rmSync(paths.health, { force: true });
    await mintCreds(infra, newIdentity(), "deprovisioner", {
      deprovisionTarget: { principal, lifecycleUid },
    })
      .then((creds) => deprovisionAgent({ servers: target.server, space: target.space, targetId: principal, lifecycleUid, creds }))
      .catch((error) => failures.push(error));
    if (failures.length) throw new AggregateError(failures, `prepareStandaloneAgent: retiring ${owner}.${name} failed`);
  });
  try {
    const grant = await provider.grantAgent({
      store,
      dir,
      space: target.space,
      owner,
      actor: name,
      scope: (capabilities ?? []).filter((capability) => capability === "spawn" || capability === "admin" || /^role:[A-Za-z0-9_-]+$/.test(capability)),
      allowSubscribe: allowSubscribe.length ? allowSubscribe : subscribe,
      allowPublish,
      role,
      parent: `${owner}.standalone`,
      label: persona.ref,
      lifecycleUid,
    });
    grantCreated = true;
    const ep = provisioner(target, await mintCreds(infra, newIdentity(), "provisioner"), "standalone-provisioner");
    try {
      await ep.start();
      await provisionAgentDurables(ep, { owner, actor: name, lifecycleUid }, {
        subscribe,
        allowSubscribe,
        role,
        ...(opts.liveOnly ? { durableMembership: false } : {}),
      });
    } finally {
      await ep.stop().catch(() => {});
    }
    await store.put(agentLifecycleActorTokenKey(name, lifecycleUid), grant.actorToken);
    await store.put(agentLifecycleSentinelCredsKey(name, lifecycleUid), grant.sentinelCreds);
    await materializeSecretToFile(store, agentLifecycleActorTokenKey(name, lifecycleUid), paths.actorToken);
    await materializeSecretToFile(store, agentLifecycleSentinelCredsKey(name, lifecycleUid), paths.sentinelCreds);
    rmSync(paths.health, { force: true });
    const bearerCmd = checkedBearerCommand(opts.userAuth.bearerCommand({
      providerCommand: provider.agentBearerCommand,
      dir,
      space: target.space,
      owner,
      actor: name,
      tokenFile: paths.actorToken,
      healthFile: paths.health,
    }));
    await verifyBearerCommand(bearerCmd);
    return {
      ...base,
      lifecycleUid,
      userAuth: { owner, actor: name, sentinelCreds: grant.sentinelCreds, bearerCmd },
      retire: cleanup,
    };
  } catch (error) {
    if (grantCreated) await cleanup().catch(() => {});
    throw error;
  }
}

/** Serialize cleanup and allow a failed retirement to be retried rather than silently treating it as done. */
function retirement(run: () => Promise<void>): () => Promise<void> {
  let done = false;
  let running: Promise<void> | undefined;
  return async () => {
    if (done) return;
    if (running) return running;
    running = run().then(() => { done = true; });
    try {
      await running;
    } finally {
      running = undefined;
    }
  };
}
