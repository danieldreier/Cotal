import {
  CotalEndpoint,
  agentFilePath,
  assertValidName,
  deprovisionAgent,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  type AgentDef,
  type EndpointKind,
} from "@cotal-ai/core";
import { defaultPersonaRef } from "./default-agent.js";
import { resolveMeshTarget, type MeshTarget, type ResolveFlags } from "./mesh-target.js";

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
  /** Fresh connection identity for an open/static standalone lifecycle. */
  id: string;
  /** Fresh lifecycle UID that the caller MUST pass to its MeshAgent. */
  lifecycleUid: string;
  /** Static credential contents, held in memory for the caller's connector-neutral configuration. */
  creds?: string;
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
    tls: target.tlsRequired,
    card: { name, role: "provisioner", kind: "endpoint" },
  });
  // The caller receives failures from start/provision directly; this prevents an unhandled EventEmitter
  // error from masking that same failure as a process crash.
  ep.on("error", () => {});
  return ep;
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
    tls: target.tlsRequired,
  });
}

/**
 * Prepare one standalone agent identity lazily. Every supported target returns a fresh, caller-owned
 * identity/lifecycle pair. Open targets do not need credentials, but their consuming endpoint still
 * creates a lifecycle-keyed inbox; retirement removes that exact inbox rather than waiting for its
 * inactive timer. Static targets also receive lifecycle-scoped credentials. User-auth is deliberately
 * refused in v1 until its actor-grant and lifecycle ownership contract is independently hardened.
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

  if (target.mode === "open") {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    return {
      ...base,
      id: identity.id,
      lifecycleUid,
      retire: retirement(() => deprovisionAgent({
        servers: target.server,
        space: target.space,
        targetId: identity.id,
        lifecycleUid,
        tls: target.tlsRequired,
      })),
    };
  }

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

  throw new Error(
    `prepareStandaloneAgent: user-auth target "${target.space}" is not supported by the standalone MCP gateway yet; select an open/static mesh or use the normal user-auth CLI until lifecycle-scoped user grants are available`,
  );
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
