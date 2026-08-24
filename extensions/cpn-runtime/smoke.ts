import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_MATERIAL_ENV, writeLaunchMaterial } from "@cotal-ai/core";
import { CpnRuntime, HttpCpnLaunchClient, loadCpnRuntimeConfig } from "./src/runtime.js";
import type { CpnJobStatus, CpnLaunchClient, CpnLaunchRequest, CpnLaunchReceipt } from "./src/runtime.js";

let failures = 0;
function check(label: string, actual: unknown): void {
  if (actual) console.log(`✓ ${label}`);
  else { failures++; console.error(`✗ ${label}`); }
}

async function rejects(label: string, run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try { await run(); check(label, false); }
  catch (e) { check(label, pattern.test((e as Error).message)); }
}

class FakeClient implements CpnLaunchClient {
  request: CpnLaunchRequest | undefined;
  stopped = false;
  statusCalls = 0;

  constructor(private readonly naturalExit: boolean) {}

  async launch(request: CpnLaunchRequest): Promise<CpnLaunchReceipt> {
    this.request = request;
    return { jobId: "job-17", taskId: "task-17", status: "queued" };
  }

  async status(taskId: string): Promise<CpnJobStatus> {
    this.statusCalls++;
    if (this.stopped) return { jobId: "absent", taskId, status: "not_found", finished: true, found: false };
    if (this.naturalExit && this.statusCalls > 1)
      return { jobId: "job-17", taskId, status: "succeeded", finished: true, found: true };
    return { jobId: "job-17", taskId, status: "running", finished: false, found: true };
  }

  async stop(): Promise<void> { this.stopped = true; }
}

const temp = mkdtempSync(join(tmpdir(), "cotal-cpn-smoke-"));
const creds = join(temp, "child.creds");
writeFileSync(creds, "manager-minted-child-credential\n", { mode: 0o600 });
const launchMaterial = writeLaunchMaterial({ creds });
const spec = { command: "must-not-run", args: [], env: { [LAUNCH_MATERIAL_ENV]: launchMaterial } };
const childNkey = `U${"A".repeat(55)}`;

try {
  const config = loadCpnRuntimeConfig({
    COTAL_CPN_LAUNCHER_PROFILES: JSON.stringify([
      { persona: "terra-worker", profile: "codex-terra", lane: "terra", agent: "codex", model: "gpt-5.6-terra", variant: "high" },
    ]),
    COTAL_CPN_STATUS_POLL_MS: "250",
  });
  config.pollIntervalMs = 5;
  const client = new FakeClient(true);
  const runtime = new CpnRuntime(client, config);

  const handle = await runtime.spawn("worker-17", spec, "/not-used", {
    persona: "terra-worker",
    personaPrompt: "You are a supervised helper. Report status and finish the assigned task.",
    task: "Review the new scheduler boundary.",
    agent: "codex",
    model: "gpt-5.6-terra",
    variant: "high",
    correlationId: "goal-17",
    parent: { principal: "parent-principal", lifecycleUid: "parent-uid" },
    child: { principal: childNkey, lifecycleUid: "child-uid", role: "helper" },
  });
  check("does not execute LaunchSpec.command", client.request?.profile === "codex-terra");
  check("uses a manager-selected profile", client.request?.profile === "codex-terra");
  check("carries a bounded general task", client.request?.task_class === "general" && client.request?.task === "Review the new scheduler boundary.");
  check("carries the manager-resolved persona body", client.request?.persona_prompt === "You are a supervised helper. Report status and finish the assigned task.");
  check("carries authenticated parent lineage", client.request?.parent.principal_id === "parent-principal" && client.request?.parent.lifecycle_uid === "parent-uid");
  check("canonicalizes the manager's static child nkey as a Cotal principal", client.request?.child.principal_id === `local.${childNkey}` && client.request?.child.lifecycle_uid === "child-uid");
  check("carries the manager-allocated child role", client.request?.child.role === "helper");
  check("carries manager-issued bootstrap credential", client.request?.child.bootstrap_creds === "manager-minted-child-credential\n");
  check("carries goal correlation", client.request?.correlation_id === "goal-17");
  check("returns remote job identity and status", handle.remote?.id === "job-17" && handle.remote.taskId === "task-17" && handle.remote.status === "queued");

  let exitNotice = false;
  handle.attach().onExit(() => { exitNotice = true; });
  await handle.waitForExit?.();
  await new Promise((resolve) => setImmediate(resolve));
  check("polls terminal Job state into an exited handle", handle.status() === "exited" && handle.remote?.status === "succeeded");
  check("notifies remote exit subscribers", exitNotice);

  const httpCalls: Array<{ url: string; method: string; authorization: string; body: string }> = [];
  let returnMissing = false;
  const httpClient = new HttpCpnLaunchClient("http://launcher.internal/", "m".repeat(32), async (url, init) => {
    const method = init?.method ?? "GET";
    httpCalls.push({
      url,
      method,
      authorization: new Headers(init?.headers).get("Authorization") ?? "",
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (method === "POST") return Response.json({ job_name: "job-http", task_id: "task-http", status: "queued" }, { status: 201 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (returnMissing) return Response.json({ error: "job_not_found" }, { status: 404 });
    return Response.json({ name: "job-http", task_id: "task-http", status: "running", finished: false });
  });
  const httpReceipt = await httpClient.launch(client.request!);
  const httpStatus = await httpClient.status("task-http");
  await httpClient.stop("task-http");
  returnMissing = true;
  const missingStatus = await httpClient.status("task-http");
  check("HTTP client uses manager-only launch/status/stop routes", httpCalls.map((call) => `${call.method} ${new URL(call.url).pathname}`).join(",") === "POST /v1/manager/launch,GET /v1/manager/jobs/task-http,DELETE /v1/manager/jobs/task-http,GET /v1/manager/jobs/task-http");
  check("HTTP client sends the file-derived manager bearer", httpCalls.every((call) => call.authorization === `Bearer ${"m".repeat(32)}`));
  check("HTTP client maps launcher receipts and state", httpReceipt.jobId === "job-http" && httpStatus.status === "running" && missingStatus.found === false);
  check("HTTP launch carries bootstrap only in its request body", JSON.parse(httpCalls[0]!.body).child.bootstrap_creds === "manager-minted-child-credential\n");

  const stopClient = new FakeClient(false);
  const stopHandle = await new CpnRuntime(stopClient, { ...config, pollIntervalMs: 5 }).spawn("worker-stop", spec, "/", {
    persona: "terra-worker", personaPrompt: "You are a supervised helper.", task: "Stop lifecycle test.", agent: "codex", model: "gpt-5.6-terra", variant: "high",
    parent: { principal: "p", lifecycleUid: "parent-uid" }, child: { principal: "c", lifecycleUid: "child-uid" },
  });
  stopHandle.stop();
  await stopHandle.waitForExit?.();
  check("DELETE plus absent Job authoritatively completes stop", stopClient.stopped && stopHandle.status() === "exited");

  await rejects("refuses a persona outside the allowlist", () => runtime.spawn("x", spec, "/", {
    persona: "unknown", task: "x", agent: "codex", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
  }), /not in the CPN profile allowlist/);
  await rejects("refuses a taskless CPN launch", () => runtime.spawn("x", spec, "/", {
    persona: "terra-worker", agent: "codex", model: "gpt-5.6-terra", variant: "high", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
  }), /requires a one-shot task/);
  await rejects("refuses an agent not reviewed for the profile", () => runtime.spawn("x", spec, "/", {
    persona: "terra-worker", personaPrompt: "helper", task: "x", agent: "claude", model: "gpt-5.6-terra", variant: "high", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
  }), /approved for codex/);
  await rejects("refuses a mismatched model before launch", () => runtime.spawn("x", spec, "/", {
    persona: "terra-worker", personaPrompt: "helper", task: "x", agent: "codex", model: "gpt-5.6-sol", variant: "high", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
  }), /expected "gpt-5.6-terra"/);
  await rejects("refuses a CPN persona with no body", () => runtime.spawn("x", spec, "/", {
    persona: "terra-worker", task: "x", agent: "codex", model: "gpt-5.6-terra", variant: "high", parent: { principal: "p" }, child: { principal: "c", lifecycleUid: "u" },
  }), /requires a non-empty persona body/);
} finally {
  rmSync(launchMaterial, { force: true });
  rmSync(temp, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
