import { readFileSync } from "node:fs";
import {
  LAUNCH_MATERIAL_ENV,
  readLaunchMaterial,
  registry,
  type AgentHandle,
  type AttachSession,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
  type RuntimeSpawnContext,
} from "@cotal-ai/core";

const MAX_TASK_BYTES = 12_000;
const MAX_BOOTSTRAP_BYTES = 64 << 10;
const MAX_RESPONSE_BYTES = 64 << 10;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type CpnTaskClass = "general" | "security";

export interface CpnProfile {
  /** Persona ref accepted from Cotal's manager control surface. */
  persona: string;
  /** Launcher-side profile, owned and allowlisted by the CPN service. */
  profile: string;
  /** Human-facing model lane recorded with the launch (terra/luna/sol, etc.). */
  lane: string;
  /** Resolved connector that is permitted to use this CPN profile. */
  agent?: string;
  /** Optional exact model/variant assertions for the persona-to-profile mapping. */
  model?: string;
  variant?: string;
  /** Fable is always general; security work is assigned to another reviewed lane. */
  taskClass?: CpnTaskClass;
}

export interface CpnRuntimeConfig {
  profiles: readonly CpnProfile[];
  /** Primarily exposed so lifecycle tests do not wait for the production poll interval. */
  pollIntervalMs?: number;
}

/** The trusted manager-to-launcher envelope. Parent/child identity is allocated by Cotal. The
 * bootstrap credential is read from Cotal's private launch material and is accepted only by the
 * manager-only launcher endpoint; it is never returned in a receipt or remote handle. */
export interface CpnLaunchRequest {
  profile: string;
  task_class: CpnTaskClass;
  task: string;
  correlation_id: string;
  parent: { principal_id: string; lifecycle_uid?: string };
  child: { name: string; principal_id: string; lifecycle_uid: string; bootstrap_creds: string };
}

/** The launcher admission receipt that Cotal returns through the spawn goal's terminal outcome. */
export interface CpnLaunchReceipt { jobId: string; taskId: string; status: string }

/** Authoritative remote lifecycle state. `found:false` means Kubernetes has proved the Job absent. */
export interface CpnJobStatus {
  jobId: string;
  taskId: string;
  status: string;
  finished: boolean;
  found: boolean;
}

/** Narrow server-side adapter. Only the manager owns its bearer token. */
export interface CpnLaunchClient {
  launch(request: CpnLaunchRequest): Promise<CpnLaunchReceipt>;
  status(taskId: string): Promise<CpnJobStatus>;
  stop(taskId: string): Promise<void>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function nonEmpty(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`cpn runtime: ${name} must be a non-empty string`);
  return v.trim();
}

function optionalString(v: unknown, name: string): string | undefined {
  return v === undefined ? undefined : nonEmpty(v, name);
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
    const taskClass = optionalString(r.taskClass, `profile entry ${i}.taskClass`);
    if (taskClass !== undefined && taskClass !== "general" && taskClass !== "security")
      throw new Error(`cpn runtime: profile entry ${i}.taskClass must be general or security`);
    const profile: CpnProfile = {
      persona: nonEmpty(r.persona, `profile entry ${i}.persona`),
      profile: nonEmpty(r.profile, `profile entry ${i}.profile`),
      lane: nonEmpty(r.lane, `profile entry ${i}.lane`),
      ...(r.agent === undefined ? {} : { agent: nonEmpty(r.agent, `profile entry ${i}.agent`) }),
      ...(r.model === undefined ? {} : { model: nonEmpty(r.model, `profile entry ${i}.model`) }),
      ...(r.variant === undefined ? {} : { variant: nonEmpty(r.variant, `profile entry ${i}.variant`) }),
      ...(taskClass === undefined ? {} : { taskClass }),
    };
    if (seen.has(profile.persona)) throw new Error(`cpn runtime: duplicate persona ${JSON.stringify(profile.persona)} in profile allowlist`);
    seen.add(profile.persona);
    return profile;
  });
}

function pollInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 60_000)
    throw new Error("cpn runtime: COTAL_CPN_STATUS_POLL_MS must be an integer from 250 through 60000");
  return value;
}

export function loadCpnRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CpnRuntimeConfig {
  return { profiles: parseProfiles(env.COTAL_CPN_LAUNCHER_PROFILES), pollIntervalMs: pollInterval(env.COTAL_CPN_STATUS_POLL_MS) };
}

function receipt(value: CpnLaunchReceipt): CpnLaunchReceipt {
  return {
    jobId: nonEmpty(value.jobId, "launcher receipt.jobId"),
    taskId: nonEmpty(value.taskId, "launcher receipt.taskId"),
    status: nonEmpty(value.status, "launcher receipt.status"),
  };
}

function status(value: CpnJobStatus): CpnJobStatus {
  return {
    jobId: nonEmpty(value.jobId, "launcher status.jobId"),
    taskId: nonEmpty(value.taskId, "launcher status.taskId"),
    status: nonEmpty(value.status, "launcher status.status"),
    finished: value.finished === true,
    found: value.found !== false,
  };
}

function launcherBaseURL(raw: string | undefined): string {
  const value = nonEmpty(raw, "COTAL_CPN_LAUNCHER_URL");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("cpn runtime: COTAL_CPN_LAUNCHER_URL must be an absolute HTTP URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("cpn runtime: COTAL_CPN_LAUNCHER_URL must be an HTTP(S) base URL without credentials, query, or fragment");
  return value.replace(/\/+$/, "");
}

function launcherToken(path: string | undefined): string {
  const tokenPath = nonEmpty(path, "COTAL_CPN_LAUNCHER_TOKEN_FILE");
  let token: string;
  try { token = readFileSync(tokenPath, "utf8").trim(); }
  catch (error) { throw new Error(`cpn runtime: cannot read the manager launcher token file (${error instanceof Error ? error.message : String(error)})`); }
  if (Buffer.byteLength(token, "utf8") < 32) throw new Error("cpn runtime: manager launcher token must contain at least 32 bytes");
  return token;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`cpn runtime: ${name} returned an invalid JSON object`);
  return value as Record<string, unknown>;
}

/** Production HTTP client for the launcher's manager-only surface. */
export class HttpCpnLaunchClient implements CpnLaunchClient {
  readonly #baseURL: string;
  readonly #token: string;
  readonly #fetch: Fetcher;

  constructor(baseURL: string, token: string, fetcher: Fetcher = globalThis.fetch) {
    this.#baseURL = launcherBaseURL(baseURL);
    if (Buffer.byteLength(token.trim(), "utf8") < 32) throw new Error("cpn runtime: manager launcher token must contain at least 32 bytes");
    this.#token = token.trim();
    this.#fetch = fetcher;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpCpnLaunchClient {
    return new HttpCpnLaunchClient(launcherBaseURL(env.COTAL_CPN_LAUNCHER_URL), launcherToken(env.COTAL_CPN_LAUNCHER_TOKEN_FILE));
  }

  async #request(method: string, path: string, body?: unknown): Promise<{ code: number; body?: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseURL}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`cpn runtime: launcher ${method} failed (${error instanceof Error ? error.message : String(error)})`);
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new Error(`cpn runtime: launcher ${method} response is too large`);
    let parsed: Record<string, unknown> | undefined;
    if (raw.trim()) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new Error(`cpn runtime: launcher ${method} returned non-JSON status ${response.status}`); }
      parsed = record(value, `launcher ${method}`);
    }
    if (!response.ok && response.status !== 404) {
      const code = typeof parsed?.error === "string" ? parsed.error : `http_${response.status}`;
      throw new Error(`cpn runtime: launcher ${method} rejected the request (${code})`);
    }
    return { code: response.status, ...(parsed === undefined ? {} : { body: parsed }) };
  }

  async launch(request: CpnLaunchRequest): Promise<CpnLaunchReceipt> {
    const response = await this.#request("POST", "/v1/manager/launch", request);
    if (response.code === 404 || response.body === undefined) throw new Error("cpn runtime: manager launch endpoint is unavailable");
    return receipt({
      jobId: nonEmpty(response.body.job_name ?? response.body.name, "launcher receipt.job_name"),
      taskId: nonEmpty(response.body.task_id, "launcher receipt.task_id"),
      status: nonEmpty(response.body.status, "launcher receipt.status"),
    });
  }

  async status(taskId: string): Promise<CpnJobStatus> {
    const response = await this.#request("GET", `/v1/manager/jobs/${encodeURIComponent(nonEmpty(taskId, "task id"))}`);
    if (response.code === 404) return { jobId: "absent", taskId, status: "not_found", finished: true, found: false };
    if (response.body === undefined) throw new Error("cpn runtime: launcher status response is empty");
    return status({
      jobId: nonEmpty(response.body.name ?? response.body.job_name, "launcher status.name"),
      taskId: nonEmpty(response.body.task_id, "launcher status.task_id"),
      status: nonEmpty(response.body.status, "launcher status.status"),
      finished: response.body.finished === true,
      found: true,
    });
  }

  async stop(taskId: string): Promise<void> {
    await this.#request("DELETE", `/v1/manager/jobs/${encodeURIComponent(nonEmpty(taskId, "task id"))}`);
  }
}

/** A Kubernetes Job handle with an authoritative async lifecycle behind Cotal's synchronous handle
 * surface. Polling starts on admission; late exit subscribers are notified immediately. */
class CpnRemoteHandle implements AgentHandle {
  readonly kind = "cpn" as const;
  readonly remote: { id: string; taskId: string; status: string };
  readonly #listeners = new Set<() => void>();
  readonly #exited: Promise<void>;
  #resolveExit!: () => void;
  #state: "running" | "exited" = "running";
  #lastError: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;

  constructor(
    readonly name: string,
    private readonly launcher: CpnLaunchClient,
    receiptValue: CpnLaunchReceipt,
    private readonly pollIntervalMs: number,
  ) {
    this.remote = { id: receiptValue.jobId, taskId: receiptValue.taskId, status: receiptValue.status };
    this.#exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.#schedule(0);
  }

  status(): "running" | "exited" { return this.#state; }

  stop(): void {
    if (this.#state === "exited" || this.#stopping) return;
    this.#stopping = true;
    this.#schedule(0);
  }

  waitForExit(): Promise<void> { return this.#exited; }

  interrupt(): void {
    throw new Error(`cpn runtime: interrupt is not supported for remote job ${this.remote.id}; stop it instead`);
  }

  attach(): AttachSession {
    return {
      cols: 0,
      rows: 0,
      backlog: () => Buffer.from(`CPN Kubernetes Job ${this.remote.id}: ${this.remote.status}${this.#lastError ? `; ${this.#lastError}` : ""}\n`),
      onData: () => () => {},
      onExit: (fn) => {
        if (this.#state === "exited") {
          queueMicrotask(fn);
          return () => {};
        }
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
      },
      write: () => { throw new Error(`cpn runtime: input is not supported for remote job ${this.remote.id}`); },
      resize: () => {},
    };
  }

  #schedule(delay: number): void {
    if (this.#state === "exited") return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { void this.#poll(); }, delay);
  }

  async #poll(): Promise<void> {
    this.#timer = undefined;
    if (this.#state === "exited") return;
    try {
      // DELETE is idempotent. Reissue it on each stopped-handle poll until Kubernetes proves the
      // Job absent, so a transient launcher/API failure cannot swallow an accepted Cotal stop.
      if (this.#stopping) await this.launcher.stop(this.remote.taskId);
      const current = status(await this.launcher.status(this.remote.taskId));
      this.remote.status = current.status;
      this.#lastError = undefined;
      if (!current.found || current.finished || current.status === "succeeded" || current.status === "failed") {
        this.#markExited();
        return;
      }
    } catch (error) {
      // A transient status failure is not evidence that the Job exited. Keep it managed and retry.
      this.#lastError = error instanceof Error ? error.message : String(error);
    }
    this.#schedule(this.pollIntervalMs);
  }

  #markExited(): void {
    if (this.#state === "exited") return;
    this.#state = "exited";
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#resolveExit();
    for (const listener of [...this.#listeners]) queueMicrotask(listener);
    this.#listeners.clear();
  }
}

let configuredClient: CpnLaunchClient | undefined;

/** Optional test/custom-composition seam. Normal manager deployments use the env-backed HTTP client. */
export function configureCpnLauncher(next: CpnLaunchClient): void {
  if (configuredClient !== undefined) throw new Error("cpn runtime: launcher client is already configured");
  configuredClient = next;
}

function bootstrapCredential(spec: LaunchSpec): string {
  const materialPath = spec.env?.[LAUNCH_MATERIAL_ENV];
  if (!materialPath) throw new Error(`cpn runtime: ${LAUNCH_MATERIAL_ENV} is missing from the manager-built launch spec`);
  const material = readLaunchMaterial(materialPath);
  if (material.userAuth !== undefined) throw new Error("cpn runtime: Kubernetes worker adoption currently requires a static manager-minted child credential");
  if (!material.creds) throw new Error("cpn runtime: manager launch material contains no static child credential path");
  let credential: string;
  try { credential = readFileSync(material.creds, "utf8"); }
  catch (error) { throw new Error(`cpn runtime: cannot read the manager-minted child credential (${error instanceof Error ? error.message : String(error)})`); }
  if (!credential.trim() || Buffer.byteLength(credential, "utf8") > MAX_BOOTSTRAP_BYTES)
    throw new Error("cpn runtime: manager-minted child credential is empty or too large");
  return credential;
}

/** Runtime backed by the CPN launcher adapter. It never starts a local child process. */
export class CpnRuntime implements Runtime {
  readonly kind = "cpn" as const;
  readonly #profiles = new Map<string, CpnProfile>();
  readonly #pollIntervalMs: number;

  constructor(private readonly launcher: CpnLaunchClient, config: CpnRuntimeConfig) {
    for (const profile of config.profiles) this.#profiles.set(profile.persona, profile);
    this.#pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async spawn(name: string, spec: LaunchSpec, _cwd: string, context?: RuntimeSpawnContext): Promise<AgentHandle> {
    if (!context) throw new Error("cpn runtime: manager did not supply the trusted launch context");
    const selected = this.#profiles.get(context.persona);
    if (!selected) throw new Error(`cpn runtime: persona ${JSON.stringify(context.persona)} is not in the CPN profile allowlist`);
    if (selected.agent !== undefined && selected.agent !== context.agent)
      throw new Error(`cpn runtime: persona ${JSON.stringify(context.persona)} is approved for ${selected.agent}, not ${context.agent}`);
    if (selected.model !== undefined && selected.model !== context.model)
      throw new Error(`cpn runtime: persona ${JSON.stringify(context.persona)} resolved model ${JSON.stringify(context.model)}, expected ${JSON.stringify(selected.model)}`);
    if (selected.variant !== undefined && selected.variant !== context.variant)
      throw new Error(`cpn runtime: persona ${JSON.stringify(context.persona)} resolved variant ${JSON.stringify(context.variant)}, expected ${JSON.stringify(selected.variant)}`);
    const task = context.task?.trim();
    if (!task) throw new Error("cpn runtime: cotal_spawn requires a one-shot task");
    if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) throw new Error(`cpn runtime: task exceeds the ${MAX_TASK_BYTES}-byte limit`);
    const remote = receipt(await this.launcher.launch({
      profile: selected.profile,
      task_class: selected.taskClass ?? "general",
      task,
      correlation_id: context.correlationId ?? `${context.child.principal}:${context.child.lifecycleUid}`,
      parent: { principal_id: context.parent.principal, ...(context.parent.lifecycleUid ? { lifecycle_uid: context.parent.lifecycleUid } : {}) },
      child: {
        name,
        principal_id: context.child.principal,
        lifecycle_uid: context.child.lifecycleUid,
        bootstrap_creds: bootstrapCredential(spec),
      },
    }));
    return new CpnRemoteHandle(name, this.launcher, remote, this.#pollIntervalMs);
  }
}

function envClient(): CpnLaunchClient { return configuredClient ?? HttpCpnLaunchClient.fromEnv(); }

export const cpnRuntimeProvider: RuntimeProvider = {
  kind: "runtime", name: "cpn",
  available: () => {
    try {
      loadCpnRuntimeConfig();
      envClient();
      return true;
    } catch { return false; }
  },
  create: () => new CpnRuntime(envClient(), loadCpnRuntimeConfig()),
};

registry.register(cpnRuntimeProvider);
