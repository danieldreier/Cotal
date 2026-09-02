/**
 * CPN laptop credential renewal.
 *
 * A laptop session is handed a bounded credential by the CPN launcher and, until this module
 * existed, nothing renewed it: the endpoint's standing-renewal machinery is armed by `creds` being
 * a FUNCTION (endpoint.ts:565) and every connector passed a string, so the connection simply died
 * at the JWT's `exp`. This module supplies both halves — the function, and the supplier behind it.
 *
 * The credential the endpoint reads lives in MEMORY, not on disk. The launcher wrapper points a
 * session at an absolute path inside ONE generation directory, so a successor generation is a path
 * the running process was never told; a cell is also un-tearable and instant inside the endpoint's
 * 12s adoption deadline (endpoint.ts:696), and — the reason that actually decides it — the 75%
 * timer and an explicit reloadCreds read the source inside the SAME single-flight (runCredsTxn,
 * endpoint.ts:747-751), so a cell makes those two reads identical by construction. Generations are
 * still written to disk, for the operator and for a later resume; nothing reads them back here.
 *
 * This module imports nothing from config.ts. config.ts imports resolveCpnRenewal from here, and a
 * cycle would be a load-order hazard for a module that runs during launch.
 */
import { isAbsolute } from "node:path";
import { credsClaims, idFromCreds } from "@cotal-ai/core";

export const RENEW_INTERVAL_DEFAULT_SECONDS = 7200;
export const RENEW_INTERVAL_MIN_SECONDS = 60;
export const DEADLINE_MIN_SECONDS = 900;
export const DEADLINE_MAX_SECONDS = 86400;
/** Matches the launcher's `maxLaptopCredsBytes` (server.go:32); a larger body is refused there
 *  anyway, and refusing it here keeps the oversized value out of the request and out of any log. */
export const MAX_CREDS_BYTES = 16384;

/** The laptop principal kinds a MODEL session may renew as. The launcher also accepts `human`
 *  (server.go:64-69); it is deliberately absent here, because human enrollment is a separate helper
 *  with no session state to preserve, and letting a model session claim it would let a renew cross
 *  the human/non-human split the issuer cross-checks. */
export const AGENT_KINDS = Object.freeze(["claude-code", "codex", "opencode"] as const);
export type CpnAgentKind = (typeof AGENT_KINDS)[number];

/** The launcher's own grammars, restated so a value it would 400 on is refused at start — where an
 *  operator sees it once — rather than once per renewal cycle for the life of the session.
 *  server.go:48 and issuer.go:20. */
const PRINCIPAL_ID = /^[a-z][a-z0-9-]{2,48}$/;
const LIFECYCLE_UID = /^[a-z0-9]{26,32}$/;

/** Exactly the fields of a launch that decide renewal. Deliberately NOT `AgentConfig`: this
 *  resolver runs INSIDE configFromEnv, before an AgentConfig exists, and `connector` is assigned by
 *  the host connector only after configFromEnv returns (mcp.ts:55-56), so it is not readable here at
 *  any price. That is why the agent kind comes from COTAL_AGENT_KIND. */
export interface CpnRenewalInputs {
  name: string;
  credsPath?: string;
  lifecycleUid?: string;
}

export interface CpnRenewalConfig {
  /** Base URL of the CPN launcher, e.g. http://127.0.0.1:18080 (no trailing slash). */
  launcherUrl: string;
  principalId: string;
  agentKind: CpnAgentKind;
  lifecycleUid: string;
  /** The credential file this session started on — the cell's seed and the generation anchor. */
  credsPath: string;
  /** `<root>` in `<root>/generations/<request_id>/cotal.creds`; successors are written beside it. */
  credentialRoot: string;
  intervalMs: number;
  /** An OVERRIDE. Undefined ⇒ each cycle asks for the lease the held credential already carries
   *  (`exp - iat`, clamped) rather than letting the launcher's 12h default silently widen it.
   *  Set by acceptance runs that want a deliberately short lease. */
  deadlineSeconds?: number;
  /** Bearer sources, tried in this order at the first cycle. */
  tokenFile?: string;
  keychainAccount: string;
  keychainService: string;
  kubeNamespace: string;
  kubeSecret: string;
}

const intFromEnv = (raw: string | undefined, name: string): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  if (!Number.isInteger(n))
    throw new Error(`COTAL config: ${name} must be a whole number of seconds (got ${JSON.stringify(raw)})`);
  return n;
};

/**
 * Decide whether this launch renews its own credential, and with what. ARMING IS A PURE FUNCTION OF
 * `COTAL_CPN_LAUNCHER_URL`: set ⇒ armed, and then anything else missing is a BROKEN LAUNCH that
 * throws (the same posture as config.ts:314's lifecycle-uid gate), because a session that believes
 * it renews and cannot is worse than one that never claimed to. The launcher BEARER is deliberately
 * NOT part of arming — resolving it shells out to the Keychain or kubectl, and a prompt or a missing
 * binary must not abort a session that is otherwise healthy; it is a cycle failure instead.
 */
export function resolveCpnRenewal(
  inputs: CpnRenewalInputs,
  env: Record<string, string | undefined>,
): CpnRenewalConfig | undefined {
  const launcherUrl = env.COTAL_CPN_LAUNCHER_URL?.trim().replace(/\/+$/, "");
  if (!launcherUrl) return undefined;

  if (!inputs.credsPath)
    throw new Error(
      "COTAL config: COTAL_CPN_LAUNCHER_URL is set but this launch carries no credential FILE " +
        "(no launch material and no COTAL_CREDS) - there is nothing to renew, which is a broken launcher, not a mode",
    );
  if (!isAbsolute(inputs.credsPath))
    throw new Error(
      `COTAL config: the credential path must be absolute; ${JSON.stringify(inputs.credsPath)} is relative, and ` +
        "resolving it against this process's cwd would write successor generations wherever the session happened to start",
    );
  if (!inputs.lifecycleUid)
    throw new Error("COTAL config: CPN renewal requires COTAL_LIFECYCLE_UID - the launcher mints it at enrollment");
  if (!LIFECYCLE_UID.test(inputs.lifecycleUid))
    throw new Error(
      `COTAL config: COTAL_LIFECYCLE_UID ${JSON.stringify(inputs.lifecycleUid)} does not match ^[a-z0-9]{26,32}$; ` +
        "every renew request would be refused with invalid_lifecycle_uid",
    );
  if (!PRINCIPAL_ID.test(inputs.name))
    throw new Error(
      `COTAL config: CPN renewal requires a launcher-shaped principal name; ${JSON.stringify(inputs.name)} ` +
        "does not match ^[a-z][a-z0-9-]{2,48}$ and every renew request would be refused with invalid_principal_id",
    );

  const declared = env.COTAL_AGENT_KIND?.trim();
  if (!declared)
    throw new Error(
      "COTAL config: CPN renewal requires COTAL_AGENT_KIND (claude-code, codex or opencode) - the launcher " +
        "cross-checks it, the wrapper already knows it at enrollment, and nothing here may guess it",
    );
  if (!(AGENT_KINDS as readonly string[]).includes(declared))
    throw new Error(`COTAL config: COTAL_AGENT_KIND must be one of ${AGENT_KINDS.join(", ")} (got ${JSON.stringify(declared)})`);
  const agentKind = declared as CpnAgentKind;

  // <root>/generations/<request_id>/cotal.creds — the shape cotal-cpn-claude:214-217 writes. A path
  // of another shape means this session was not enrolled the way successors are written, so refuse
  // rather than invent a root and scatter generations somewhere nobody looks.
  const parts = inputs.credsPath.split("/");
  if (parts.length < 4 || parts[parts.length - 3] !== "generations")
    throw new Error(
      `COTAL config: CPN renewal expects the credential at <root>/generations/<request-id>/<file>; ` +
        `${JSON.stringify(inputs.credsPath)} is not in a generations directory`,
    );
  const credentialRoot = parts.slice(0, -3).join("/") || "/";

  const intervalSeconds = intFromEnv(env.COTAL_CPN_RENEW_INTERVAL_SECONDS, "COTAL_CPN_RENEW_INTERVAL_SECONDS")
    ?? RENEW_INTERVAL_DEFAULT_SECONDS;
  if (intervalSeconds < RENEW_INTERVAL_MIN_SECONDS)
    throw new Error(`COTAL config: COTAL_CPN_RENEW_INTERVAL_SECONDS must be at least ${RENEW_INTERVAL_MIN_SECONDS}`);

  const deadlineSeconds = intFromEnv(env.COTAL_CPN_RENEW_DEADLINE_SECONDS, "COTAL_CPN_RENEW_DEADLINE_SECONDS");
  if (deadlineSeconds !== undefined && (deadlineSeconds < DEADLINE_MIN_SECONDS || deadlineSeconds > DEADLINE_MAX_SECONDS))
    throw new Error(`COTAL config: COTAL_CPN_RENEW_DEADLINE_SECONDS must be between ${DEADLINE_MIN_SECONDS} and ${DEADLINE_MAX_SECONDS}`);

  return {
    launcherUrl,
    principalId: inputs.name,
    agentKind,
    lifecycleUid: inputs.lifecycleUid,
    credsPath: inputs.credsPath,
    credentialRoot,
    intervalMs: intervalSeconds * 1000,
    deadlineSeconds,
    tokenFile: env.COTAL_CPN_LAUNCHER_TOKEN_FILE?.trim() || undefined,
    keychainAccount: "cpn-agent-launcher",
    keychainService: "cpn-agent-launcher-api-token",
    kubeNamespace: "cpn-agents-pilot",
    kubeSecret: "cpn-agent-launcher-auth",
  };
}

/** The window a credential describes. Same shape the endpoint's reloadCreds returns
 *  (endpoint.ts:835), so a caller can compare the cell's view against the endpoint's. */
export interface CpnCredsWindow {
  identity: string;
  iat?: number;
  exp?: number;
}

/**
 * The one credential the endpoint's source returns. Written by the renewal loop, read by the
 * endpoint on every (re)connect attempt and on every adoption. The nkey is pinned HERE as well as
 * in the endpoint (endpoint.ts:707,782) — not redundantly: the endpoint's pin protects the live
 * connection, this one keeps a wrong-identity credential from ever being written to disk as a
 * generation of THIS principal.
 */
export class CredsCell {
  private creds: string;
  readonly id: string;

  constructor(initial: string) {
    this.id = idFromCreds(initial);   // throws on a spliced/corrupt file, before anything starts
    this.creds = initial;
  }

  current(): string {
    return this.creds;
  }

  window(): CpnCredsWindow {
    const { iat, exp } = credsClaims(this.creds);
    return { identity: this.id, iat, exp };
  }

  /** Expiry of the credential currently held, in ms since epoch; undefined if it carries none. */
  expiresAt(): number | undefined {
    const exp = credsClaims(this.creds).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  }

  /** The lease this credential was issued with, in seconds — what a renewal asks for again.
   *  Undefined when either claim is missing, in which case the caller sends no deadline_seconds and
   *  takes the launcher's default rather than inventing a number. */
  leaseSeconds(): number | undefined {
    const { iat, exp } = credsClaims(this.creds);
    if (typeof iat !== "number" || typeof exp !== "number") return undefined;
    const lease = Math.round(exp - iat);
    return lease > 0 ? lease : undefined;
  }

  adopt(next: string): void {
    const id = idFromCreds(next);
    if (id !== this.id)
      throw new Error(`CPN renewal returned identity ${id}, expected ${this.id} - a renewal may not swap this session's nkey`);
    this.creds = next;
  }
}

/** Why an adoption failed, and — the part a caller cannot recover without — WHICH credential the
 *  session was left holding. `leftOn: "new"` means the rollback itself failed and the session is
 *  running on the broker-accepted candidate; `"previous"` means nothing moved. `window` is the
 *  ENDPOINT's committed window at the moment the error was raised, so a test can assert it against
 *  the cell's. */
export class CpnAdoptError extends Error {
  constructor(
    readonly stage: "reload" | "reconnect" | "rollback",
    readonly leftOn: "previous" | "new",
    readonly window: CpnCredsWindow | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CpnAdoptError";
  }
}
