import { registry, type AgentHandle, type LaunchSpec, type Runtime, type RuntimeProvider, type RuntimeSpawnContext } from "@cotal-ai/core";

const MAX_TASK_BYTES = 12_000;

export interface CpnProfile {
  /** Persona ref accepted from Cotal's manager control surface. */
  persona: string;
  /** Launcher-side profile, owned and allowlisted by the CPN service. */
  profile: string;
  /** Human-facing model lane recorded with the launch (terra/luna/sol, etc.). */
  lane: string;
  /** Resolved connector that is permitted to use this CPN profile. */
  agent?: string;
}

export interface CpnRuntimeConfig { profiles: readonly CpnProfile[] }

/** The non-secret contract from Cotal's manager to its in-cluster launcher adapter. `parent` is
 * derived from the broker-authenticated service caller, while `child` is allocated by the manager
 * before this runtime runs. The launcher must resolve that child to its server-side enrollment;
 * it must never ask an ordinary Cotal agent for a launcher credential. */
export interface CpnLaunchRequest {
  profile: string;
  task_class: "one-shot";
  task: string;
  correlation_id: string;
  parent: { principal_id: string; lifecycle_uid?: string };
  child: { name: string; principal_id: string; lifecycle_uid: string };
}

/** The launcher admission receipt that Cotal returns through the spawn goal's terminal outcome. */
export interface CpnLaunchReceipt { jobId: string; taskId: string; status: string }

/** Server-side implementation boundary. The production CPN composition owns the authenticated
 * HTTP client and any secret/enrollment handoff; this extension deliberately has neither a bearer
 * token nor a URL configuration, so importing it into an agent process cannot create pods. */
export interface CpnLaunchClient { launch(request: CpnLaunchRequest): Promise<CpnLaunchReceipt> }

let client: CpnLaunchClient | undefined;

/** Configure the one trusted server-side launcher adapter before selecting runtime `cpn`. */
export function configureCpnLauncher(next: CpnLaunchClient): void {
  if (client !== undefined) throw new Error("cpn runtime: launcher client is already configured");
  client = next;
}

function nonEmpty(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`cpn runtime: ${name} must be a non-empty string`);
  return v.trim();
}

function parseProfiles(raw: string | undefined): CpnProfile[] {
  if (!raw?.trim()) throw new Error("cpn runtime: COTAL_CPN_LAUNCHER_PROFILES is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("cpn runtime: COTAL_CPN_LAUNCHER_PROFILES must be JSON"); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("cpn runtime: COTAL_CPN_LAUNCHER_PROFILES must be a non-empty JSON array");
  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`cpn runtime: profile entry ${i} must be an object`);
    const r = entry as Record<string, unknown>;
    const profile = {
      persona: nonEmpty(r.persona, `profile entry ${i}.persona`),
      profile: nonEmpty(r.profile, `profile entry ${i}.profile`),
      lane: nonEmpty(r.lane, `profile entry ${i}.lane`),
      ...(r.agent === undefined ? {} : { agent: nonEmpty(r.agent, `profile entry ${i}.agent`) }),
    };
    if (seen.has(profile.persona)) throw new Error(`cpn runtime: duplicate persona ${JSON.stringify(profile.persona)} in profile allowlist`);
    seen.add(profile.persona);
    return profile;
  });
}

export function loadCpnRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CpnRuntimeConfig {
  return { profiles: parseProfiles(env.COTAL_CPN_LAUNCHER_PROFILES) };
}

function receipt(value: CpnLaunchReceipt): CpnLaunchReceipt {
  return {
    jobId: nonEmpty(value.jobId, "launcher receipt.jobId"),
    taskId: nonEmpty(value.taskId, "launcher receipt.taskId"),
    status: nonEmpty(value.status, "launcher receipt.status"),
  };
}

/** Runtime backed by the CPN launcher adapter. It never starts a local child process. */
export class CpnRuntime implements Runtime {
  readonly kind = "cpn" as const;
  readonly #profiles = new Map<string, CpnProfile>();

  constructor(private readonly launcher: CpnLaunchClient, config: CpnRuntimeConfig) {
    for (const profile of config.profiles) this.#profiles.set(profile.persona, profile);
  }

  async spawn(name: string, _spec: LaunchSpec, _cwd: string, context?: RuntimeSpawnContext): Promise<AgentHandle> {
    if (!context) throw new Error("cpn runtime: manager did not supply the trusted launch context");
    const selected = this.#profiles.get(context.persona);
    if (!selected) throw new Error(`cpn runtime: persona ${JSON.stringify(context.persona)} is not in the CPN profile allowlist`);
    if (selected.agent !== undefined && selected.agent !== context.agent)
      throw new Error(`cpn runtime: persona ${JSON.stringify(context.persona)} is approved for ${selected.agent}, not ${context.agent}`);
    const task = context.task?.trim();
    if (!task) throw new Error("cpn runtime: cotal_spawn requires a one-shot task");
    if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) throw new Error(`cpn runtime: task exceeds the ${MAX_TASK_BYTES}-byte limit`);
    const remote = receipt(await this.launcher.launch({
      profile: selected.profile,
      task_class: "one-shot",
      task,
      correlation_id: context.correlationId ?? `${context.child.principal}:${context.child.lifecycleUid}`,
      parent: { principal_id: context.parent.principal, ...(context.parent.lifecycleUid ? { lifecycle_uid: context.parent.lifecycleUid } : {}) },
      child: { name, principal_id: context.child.principal, lifecycle_uid: context.child.lifecycleUid },
    }));
    let exited = false;
    return {
      name, kind: this.kind, remote: { id: remote.jobId, taskId: remote.taskId, status: remote.status },
      status: () => (exited ? "exited" : "running"),
      stop: () => { exited = true; throw new Error(`cpn runtime: stopping remote job ${remote.jobId} is not implemented by the launcher API`); },
      interrupt: () => { throw new Error(`cpn runtime: interrupt is not supported for remote job ${remote.jobId}`); },
      attach: () => { throw new Error(`cpn runtime: attach is not supported for remote job ${remote.jobId}; inspect it through the CPN launcher`); },
    };
  }
}

export const cpnRuntimeProvider: RuntimeProvider = {
  kind: "runtime", name: "cpn",
  available: () => {
    try { return client !== undefined && loadCpnRuntimeConfig().profiles.length > 0; } catch { return false; }
  },
  create: () => {
    if (!client) throw new Error("cpn runtime: no server-side launcher client is configured");
    return new CpnRuntime(client, loadCpnRuntimeConfig());
  },
};

registry.register(cpnRuntimeProvider);
