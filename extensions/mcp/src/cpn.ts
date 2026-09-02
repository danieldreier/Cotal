import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PreparedGatewayAgent } from "./gateway.js";

/** CPN's loopback-only laptop gateway contract. These are not public defaults. */
const CPN_SPACE = "cpn-pilot";
const CPN_NATS = "nats://127.0.0.1:14222";
const CPN_LAUNCHER = "http://127.0.0.1:18080";
const CPN_NAMESPACE = "cpn-agents-pilot";
const CPN_CHANNELS = ["coordination", "project.whilefork-infra", "prs", "ci-infrastructure"];
const CPN_ALLOW_CHANNELS = ["project.>", "coordination", "prs", "ci-infrastructure"];

export type CpnRole = "leader" | "helper";

export interface CpnGatewayOptions {
  principal?: string;
  role?: CpnRole;
}

const enrollmentSchema = z.object({
  request_id: z.string().regex(/^[A-Za-z0-9-]+$/),
  creds: z.string().min(1),
  lifecycle_uid: z.string().min(1),
  expires_at: z.string().min(1),
}).passthrough();

function setting(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function assertRole(role: string | undefined): CpnRole {
  if (role === undefined || role === "leader") return "leader";
  if (role === "helper") return "helper";
  throw new Error("cotal mcp --cpn: --role must be leader or helper");
}

function assertPrincipalPrefix(principal: string | undefined): string | undefined {
  if (principal === undefined) return undefined;
  if (!/^[a-z][a-z0-9-]{2,48}$/.test(principal))
    throw new Error("cotal mcp --cpn: --principal must be 3-49 characters of lowercase DNS-safe text");
  return principal;
}

/** A supplied principal is a label prefix, never a reusable identity. */
export function freshCpnPrincipal(role: CpnRole, prefix?: string): string {
  const supplied = assertPrincipalPrefix(prefix);
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const base = supplied ?? `laptop-mcp-${role}`;
  const shortened = base.slice(0, Math.max(3, 49 - suffix.length - 1)).replace(/-+$/, "") || "mcp";
  return `${shortened}-${suffix}`;
}

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function portHealthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function startTunnel(name: string, service: string, localPort: number, remotePort: number): Promise<void> {
  if (await portHealthy(localPort)) return;
  const root = setting("COTAL_CPN_MCP_TUNNEL_ROOT", join(homedir(), ".cotal", CPN_SPACE, ".mcp-tunnels"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const child = spawn("kubectl", ["-n", CPN_NAMESPACE, "port-forward", `service/${service}`, `${localPort}:${remotePort}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await writeFile(join(root, `${name}.pid`), `${child.pid}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (await portHealthy(localPort)) return;
  }
  throw new Error(`cotal mcp --cpn: could not establish ${name} loopback tunnel`);
}

async function ensureTunnels(): Promise<void> {
  await startTunnel("launcher", "cpn-agent-launcher", 18_080, 8_080);
  await startTunnel("nats", "cotal-nats", 14_222, 4_222);
}

async function launcherToken(): Promise<string> {
  try {
    const token = (await exec("security", ["find-generic-password", "-w", "-a", "cpn-agent-launcher", "-s", "cpn-agent-launcher-api-token"])).trim();
    if (token) return token;
  } catch {
    // The runbook's reviewed fallback is a scoped Kubernetes secret read.
  }
  const encoded = (await exec("kubectl", ["-n", CPN_NAMESPACE, "get", "secret", "cpn-agent-launcher-auth", "-o", "jsonpath={.data.token}"])).trim();
  const token = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!token || /[\s"\\]/.test(token)) throw new Error("cotal mcp --cpn: launcher bearer token has an unexpected format");
  return token;
}

async function enroll(principal: string, role: CpnRole): Promise<z.infer<typeof enrollmentSchema>> {
  const token = await launcherToken();
  const base = setting("COTAL_CPN_MCP_LAUNCHER_URL", CPN_LAUNCHER);
  const response = await fetch(new URL("/v1/laptop-principals/register", base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ principal_id: principal, agent_kind: "codex", mesh_role: role }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`cotal mcp --cpn: launcher enrollment failed (${response.status})`);
  return enrollmentSchema.parse(await response.json());
}

/**
 * Enroll one gateway-owned CPN identity. The MCP client selects only an opaque
 * handle; it never receives, supplies, or persists a mesh credential.
 */
export async function prepareCpnGatewayAgent(options: CpnGatewayOptions = {}): Promise<PreparedGatewayAgent> {
  const role = assertRole(options.role);
  const principal = freshCpnPrincipal(role, options.principal);
  await ensureTunnels();
  const enrollment = await enroll(principal, role);
  const root = setting("COTAL_CPN_MCP_CREDENTIAL_ROOT", join(homedir(), ".cotal", CPN_SPACE, "mcp-gateway"));
  const directory = join(root, enrollment.request_id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await chmod(directory, 0o700);
  const credsPath = join(directory, "cotal.creds");
  await writeFile(credsPath, enrollment.creds, { mode: 0o600 });
  await writeFile(join(directory, "lifecycle-uid"), `${enrollment.lifecycle_uid}\n`, { mode: 0o600 });
  await writeFile(join(directory, "expires-at"), `${enrollment.expires_at}\n`, { mode: 0o600 });
  await Promise.all([credsPath, join(directory, "lifecycle-uid"), join(directory, "expires-at")].map((path) => chmod(path, 0o600)));
  return {
    target: { space: CPN_SPACE, server: setting("COTAL_CPN_MCP_NATS_URL", CPN_NATS), tlsRequired: false },
    creds: enrollment.creds,
    lifecycleUid: enrollment.lifecycle_uid,
    name: principal,
    role,
    description: "CPN gateway identity",
    tags: ["cpn", "mcp"],
    capabilities: ["spawn"],
    subscribe: CPN_CHANNELS,
    allowSubscribe: CPN_ALLOW_CHANNELS,
    allowPublish: CPN_ALLOW_CHANNELS,
    quiet: [],
    muted: [],
    kind: "agent",
    // The launcher owns revocation; this gateway only deletes the material it
    // created after the endpoint leaves, so a later client cannot reuse it.
    retire: async () => { await rm(directory, { recursive: true, force: true }); },
  };
}
