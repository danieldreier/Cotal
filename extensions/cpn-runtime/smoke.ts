import { CpnRuntime, loadCpnRuntimeConfig } from "./src/runtime.js";
import type { CpnLaunchRequest } from "./src/runtime.js";

let failures = 0;
function check(label: string, actual: unknown): void {
  if (actual) console.log(`✓ ${label}`);
  else { failures++; console.error(`✗ ${label}`); }
}

async function rejects(label: string, run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await run(); check(label, false); }
  catch (e) { check(label, pattern.test((e as Error).message)); }
}

const config = loadCpnRuntimeConfig({
  COTAL_CPN_LAUNCHER_PROFILES: JSON.stringify([
    { persona: "terra-worker", profile: "codex-terra", lane: "terra", agent: "codex" },
  ]),
});
let request: CpnLaunchRequest | undefined;
const runtime = new CpnRuntime({ launch: async (r) => {
  request = r;
  return { jobId: "job-17", taskId: "task-17", status: "accepted" };
} }, config);

const handle = await runtime.spawn("worker-17", { command: "must-not-run", args: [] }, "/not-used", {
  persona: "terra-worker",
  task: "Review the new scheduler boundary.",
  agent: "codex",
  model: "gpt-5.6-terra",
  variant: "high",
  correlationId: "goal-17",
  parent: { principal: "parent-principal", lifecycleUid: "parent-uid" },
  child: { principal: "child-principal", lifecycleUid: "child-uid" },
});
check("does not execute LaunchSpec.command", request?.profile === "codex-terra");
check("uses a manager-selected profile", request?.profile === "codex-terra");
check("carries a bounded one-shot task", request?.task_class === "one-shot" && request?.task === "Review the new scheduler boundary.");
check("carries authenticated parent lineage", request?.parent.principal_id === "parent-principal" && request?.parent.lifecycle_uid === "parent-uid");
check("carries manager-issued child lineage", request?.child.principal_id === "child-principal" && request?.child.lifecycle_uid === "child-uid");
check("carries goal correlation", request?.correlation_id === "goal-17");
check("returns remote job identity and status", handle.remote?.id === "job-17" && handle.remote.taskId === "task-17" && handle.remote.status === "accepted");

await rejects("refuses a persona outside the allowlist", () => runtime.spawn("x", { command: "ignored", args: [] }, "/", {
  persona: "unknown", task: "x", agent: "codex", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
}), /not in the CPN profile allowlist/);
await rejects("refuses a taskless CPN launch", () => runtime.spawn("x", { command: "ignored", args: [] }, "/", {
  persona: "terra-worker", agent: "codex", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
}), /requires a one-shot task/);
await rejects("refuses an agent not reviewed for the profile", () => runtime.spawn("x", { command: "ignored", args: [] }, "/", {
  persona: "terra-worker", task: "x", agent: "claude", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
}), /approved for codex/);

if (failures) process.exitCode = 1;
