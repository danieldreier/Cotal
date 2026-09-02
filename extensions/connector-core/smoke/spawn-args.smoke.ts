/**
 * cotal_spawn parity smoke — proves the MCP spawn door carries the same harness/model/variant/task knobs as the
 * operator's `cotal spawn --detach`. The `cotal_spawn` tool forwards to MeshAgent.spawn, which (1c.2b/2c)
 * puts `agent` plus model selectors into the manager's v0.4 `spawn` command over the generic invoke path
 * (`CotalEndpoint.invokeService`) in EVERY auth mode — the user-mode caller triple is the endpoint's own
 * bearer-derived principal + the launcher's lifecycle uid, so there is no ctl branch left. No NATS: the
 * MeshAgent constructor builds an endpoint but never connects, so we swap in a recording `ep` and mark
 * connected. Run with: pnpm smoke:spawn-args
 */
import { MeshAgent, SPAWN_TIMEOUT_MS } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [],
};
const a = new MeshAgent(cfg);

const spawnTool = cotalToolSpecs(cfg).find((spec) => spec.name === "cotal_spawn");
check("open-mode tool surface includes cotal_spawn", spawnTool !== undefined);
check("task is optional for generic local runtimes", spawnTool?.schema.safeParse({ name: "plain" }).success === true);
check("task accepts its 12,000-character boundary", spawnTool?.schema.safeParse({ name: "tasked", task: "x".repeat(12_000) }).success === true);
check("task refuses an empty string", spawnTool?.schema.safeParse({ name: "tasked", task: "" }).success === false);
check("task refuses more than 12,000 characters", spawnTool?.schema.safeParse({ name: "tasked", task: "x".repeat(12_001) }).success === false);

// Record the generic invoke instead of sending it; mark connected so requireConnected() passes.
type Recorded = { endpoint: string; command: string; args?: Record<string, unknown>; opts?: { target?: unknown; deadlineMs?: number } };
let rec: Recorded | undefined;
(a as unknown as {
  ep: {
    invokeService: (endpoint: string, command: string, args?: Record<string, unknown>, opts?: { target?: unknown; deadlineMs?: number }) => Promise<unknown>;
    principal: { owner: string; actor: string };
  };
}).ep = {
  invokeService: (endpoint, command, args, opts) => {
    rec = { endpoint, command, args, opts };
    return Promise.resolve({ reply: { ok: true, data: { name: args?.name } }, responder: { endpoint, instanceId: "i", epoch: 0 } });
  },
  principal: { owner: "local", actor: "caller" },
};
(a as unknown as { _connected: boolean })._connected = true;

// Full knobs: harness + model selectors + the peer-facing task ride through to the manager's v0.4
// `spawn` command. Task deliberately translates to the generic launch grammar's existing `prompt`.
await a.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet", variant: "high", task: "Review the bounded change." });
check("command is the manager endpoint's `spawn`", rec?.endpoint === "manager" && rec?.command === "spawn", rec);
check("name forwarded", rec?.args?.name === "rev");
check("role forwarded", rec?.args?.role === "reviewer");
check("agent (harness) forwarded", rec?.args?.agent === "opencode", rec?.args?.agent);
check("model forwarded", rec?.args?.model === "sonnet", rec?.args?.model);
check("variant forwarded", rec?.args?.variant === "high", rec?.args?.variant);
check("task translates to the manager's generic prompt field", rec?.args?.prompt === "Review the bounded change.", rec?.args);
check("connector does not invent a manager task field", !("task" in (rec?.args ?? {})), rec?.args);
// #159 B1: the manager replies to `spawn` only on a real outcome (join / exit / ~30s readiness
// backstop) — the request must carry the long spawn window, not fall back to the op default.
check("request outlives the readiness wait (SPAWN_TIMEOUT_MS, not the default deadline)", rec?.opts?.deadlineMs === SPAWN_TIMEOUT_MS, rec?.opts?.deadlineMs);

// Name-only: agent/model/variant absent → STRIPPED before the closed input contract validates
// (a present-but-undefined key would refuse at additionalProperties:false), so the manager
// applies its defaults (env/Claude, file model).
await a.spawn("plain");
check("name-only: agent key absent", !("agent" in (rec?.args ?? {})));
check("name-only: model key absent", !("model" in (rec?.args ?? {})));
check("name-only: variant key absent", !("variant" in (rec?.args ?? {})));
check("name-only: role key absent", !("role" in (rec?.args ?? {})));
check("name-only: prompt key absent", !("prompt" in (rec?.args ?? {})));

// The tool declaration must carry the validated task into MeshAgent.spawn, not merely advertise it.
if (spawnTool) await spawnTool.run(a, cfg, spawnTool.schema.parse({ name: "tool-tasked", task: "Run one tiny probe." }));
check("cotal_spawn dispatches task through the existing prompt contract", rec?.args?.prompt === "Run one tiny probe.", rec?.args);

// USER MODE rides the SAME invokeService door (1c.2c: the endpoint's bearer-derived principal +
// the launcher's lifecycle uid ARE the caller triple; no ctl branch remains in the connector).
const u = new MeshAgent({ ...cfg, userAuth: { bearerCmd: ["true"], sentinelCreds: "sentinel", owner: "u_x", actor: "cli" } } as AgentConfig);
let recUser: Recorded | undefined;
(u as unknown as {
  ep: {
    invokeService: (endpoint: string, command: string, args?: Record<string, unknown>, opts?: { target?: unknown; deadlineMs?: number }) => Promise<unknown>;
    principal: { owner: string; actor: string };
  };
}).ep = {
  invokeService: (endpoint, command, args, opts) => {
    recUser = { endpoint, command, args, opts };
    return Promise.resolve({ reply: { ok: true, data: { name: args?.name } }, responder: { endpoint, instanceId: "i", epoch: 0 } });
  },
  principal: { owner: "u_x", actor: "cli" },
};
(u as unknown as { _connected: boolean })._connected = true;
await u.spawn("rev", "reviewer", { agent: "opencode", model: "sonnet" });
check("user mode: the SAME v0.4 spawn command over invokeService (no ctl branch left)",
  recUser?.endpoint === "manager" && recUser?.command === "spawn" && recUser?.args?.model === "sonnet", recUser);
check("user mode: request carries the readiness window too", recUser?.opts?.deadlineMs === SPAWN_TIMEOUT_MS, recUser?.opts?.deadlineMs);

console.log(`\nSPAWN-ARGS SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
