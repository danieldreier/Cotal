// Validates that CPN credential renewal arms on exactly the environment that can drive it, refuses a
// half-configured launch loudly instead of degrading, and leaves an unconfigured launch untouched.
//
// Pure table test: no broker, no network, no filesystem. The subject is resolveCpnRenewal, the one
// function that decides whether a session renews its own launcher-minted credential.
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import {
  mapRenewStatus,
  renewCredential,
  renewDeadlineSeconds,
  resolveCpnRenewal,
  RENEW_INTERVAL_DEFAULT_SECONDS,
  type CpnRenewalInputs,
} from "../src/cpn-renew.js";

let checks = 0;
const check = (name: string, fn: () => void) => { fn(); checks++; console.log(`  ✓ ${name}`); };

const base = (over: Partial<CpnRenewalInputs> = {}): CpnRenewalInputs => ({
  name: "laptop-claude-helper-1",
  credsPath: "/r/generations/abc/cotal.creds",
  lifecycleUid: "01hxxxxxxxxxxxxxxxxxxxxxxx",
  ...over,
});
const env = (over: Record<string, string> = {}) => ({
  COTAL_CPN_LAUNCHER_URL: "http://127.0.0.1:18080",
  COTAL_AGENT_KIND: "claude-code",
  ...over,
});

check("no launcher URL ⇒ not armed", () => assert.equal(resolveCpnRenewal(base(), {}), undefined));
check("armed with the defaults", () => {
  const r = resolveCpnRenewal(base(), env())!;
  assert.equal(r.intervalMs, RENEW_INTERVAL_DEFAULT_SECONDS * 1000);
  assert.equal(r.agentKind, "claude-code");
  assert.equal(r.principalId, "laptop-claude-helper-1");
  assert.equal(r.deadlineSeconds, undefined);   // undefined ⇒ derived per cycle from the held lease (D-j)
  assert.equal(r.credentialRoot, "/r");
  assert.equal(r.launcherUrl, "http://127.0.0.1:18080");
});
check("a trailing slash on the launcher URL is normalised away", () =>
  assert.equal(resolveCpnRenewal(base(), env({ COTAL_CPN_LAUNCHER_URL: "http://127.0.0.1:18080//" }))!.launcherUrl,
    "http://127.0.0.1:18080"));
check("interval below the floor is refused, not clamped", () =>
  assert.throws(() => resolveCpnRenewal(base(), env({ COTAL_CPN_RENEW_INTERVAL_SECONDS: "59" })), /at least 60/));
check("a non-numeric interval is refused", () =>
  assert.throws(() => resolveCpnRenewal(base(), env({ COTAL_CPN_RENEW_INTERVAL_SECONDS: "2h" })), /whole number of seconds/));
check("deadline outside [900, 86400] is refused", () => {
  assert.throws(() => resolveCpnRenewal(base(), env({ COTAL_CPN_RENEW_DEADLINE_SECONDS: "899" })), /between 900 and 86400/);
  assert.throws(() => resolveCpnRenewal(base(), env({ COTAL_CPN_RENEW_DEADLINE_SECONDS: "86401" })), /between 900 and 86400/);
  assert.equal(resolveCpnRenewal(base(), env({ COTAL_CPN_RENEW_DEADLINE_SECONDS: "900" }))!.deadlineSeconds, 900);
});
check("a launcher URL with no credential file is a broken launch, not a mode", () =>
  assert.throws(() => resolveCpnRenewal(base({ credsPath: undefined }), env()), /COTAL_CREDS/));
check("a RELATIVE credential path is refused", () =>
  assert.throws(() => resolveCpnRenewal(base({ credsPath: "r/generations/abc/cotal.creds" }), env()), /absolute/));
check("a launcher URL with no lifecycle uid is refused", () =>
  assert.throws(() => resolveCpnRenewal(base({ lifecycleUid: undefined }), env()), /COTAL_LIFECYCLE_UID/));
check("a lifecycle uid the launcher would 400 on is refused here", () =>
  assert.throws(() => resolveCpnRenewal(base({ lifecycleUid: "NOT-A-UID" }), env()), /\^\[a-z0-9\]\{26,32\}\$/));
check("a principal that the launcher would refuse is refused here", () =>
  assert.throws(() => resolveCpnRenewal(base({ name: "Laptop_Claude" }), env()), /principal/));
check("an absent COTAL_AGENT_KIND is refused (the wrapper exports it; nothing guesses it)", () =>
  assert.throws(() => resolveCpnRenewal(base(), { COTAL_CPN_LAUNCHER_URL: "http://127.0.0.1:18080" }), /COTAL_AGENT_KIND/));
check("an unknown COTAL_AGENT_KIND is refused", () =>
  assert.throws(() => resolveCpnRenewal(base(), env({ COTAL_AGENT_KIND: "emacs" })), /claude-code, codex, opencode/));
check("agent_kind human is refused: it is a launcher kind, not a model session", () =>
  assert.throws(() => resolveCpnRenewal(base(), env({ COTAL_AGENT_KIND: "human" })), /claude-code, codex, opencode/));
check("a credential path outside a generations directory is refused", () =>
  assert.throws(() => resolveCpnRenewal(base({ credsPath: "/r/cotal.creds" }), env()), /generations/));
check("an explicit token file rides through", () =>
  assert.equal(resolveCpnRenewal(base(), env({ COTAL_CPN_LAUNCHER_TOKEN_FILE: "/t/tok" }))!.tokenFile, "/t/tok"));

const mappingRows: Array<[number, string | undefined, string]> = [
  [400, "invalid_json", "invalid_request"],
  [400, "invalid_principal_id", "invalid_request"],
  [400, "invalid_agent_kind", "invalid_request"],
  [400, "invalid_mesh_role", "invalid_request"],
  [400, "invalid_lifecycle_uid", "invalid_request"],
  [400, "invalid_current_creds", "invalid_request"],
  [400, "invalid_deadline_seconds", "invalid_request"],
  [401, undefined, "unauthorized"],
  [500, "request_id_failed", "launcher_error"],
  [502, "audit_write_failed", "launcher_error"],
  [502, "issuer_error", "issuer_error"],
  [409, "credential_expired", "credential_expired"],
  [422, "credential_rejected", "credential_rejected"],
  [422, "grant_mismatch", "grant_mismatch"],
  [503, "broker_unreachable", "broker_unreachable"],
  [503, "external_issuer_failed", "issuer_error"],
  [500, undefined, "unexpected"],
  [502, undefined, "unexpected"],
  [409, "something_else", "unexpected"],
  [422, undefined, "unexpected"],
];
for (const [status, code, expected] of mappingRows)
  check(`HTTP ${status}${code ? ` ${code}` : ""} maps to ${expected}`, () =>
    assert.equal(mapRenewStatus(status, code), expected));

check("deadline derivation preserves the lease and logs exactly its two clamps", () => {
  const cfg = resolveCpnRenewal(base(), env())!;
  const logs: string[] = [];
  assert.equal(renewDeadlineSeconds({ ...cfg, deadlineSeconds: 900 }, 43_200, logs.push.bind(logs)), 900);
  assert.equal(renewDeadlineSeconds(cfg, undefined, logs.push.bind(logs)), undefined);
  assert.equal(renewDeadlineSeconds(cfg, 43_200, logs.push.bind(logs)), 43_200);
  assert.equal(renewDeadlineSeconds(cfg, 60, logs.push.bind(logs)), 900);
  assert.equal(renewDeadlineSeconds(cfg, 999_999, logs.push.bind(logs)), 86_400);
  assert.equal(logs.length, 2);
});

// A real local HTTP server validates the exact request wire shape. In particular, current_creds
// must cross JSON unchanged: the launcher admits only the canonical two-block grammar, including
// LF endings and the final newline.
await new Promise<void>((resolve, reject) => {
  const currentCreds = "-----BEGIN NATS USER JWT-----\nJWT\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSUAAAA\n------END USER NKEY SEED------\n";
  const cfg = { ...resolveCpnRenewal(base(), env())!, launcherUrl: "" };
  const problems: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/laptop-principals/renew");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (body.current_creds !== currentCreds) problems.push("current_creds was not byte-identical to the held file");
        if ("mesh_role" in body) problems.push("mesh_role was sent despite being optional on renew");
        if (body.lifecycle_uid !== cfg.lifecycleUid) problems.push("lifecycle_uid was absent or changed");
        if (body.deadline_seconds !== 900) problems.push("deadline_seconds was absent or changed");
      } catch (error) {
        problems.push((error as Error).message);
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        creds: currentCreds, expires_at: "2026-09-03T00:00:00Z", lifecycle_uid: cfg.lifecycleUid,
        principal_id: cfg.principalId, request_id: "request-1", servers: "nats://127.0.0.1:4222",
      }));
    });
  });
  server.on("error", reject);
  server.listen(0, "127.0.0.1", async () => {
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const result = await renewCredential({ ...cfg, launcherUrl: `http://127.0.0.1:${address.port}` }, "opaque-token", currentCreds, 900);
      assert.equal(result.creds, currentCreds);
      assert.deepEqual(problems, []);
      checks++;
      console.log("  ✓ renew POST preserves current_creds and omits mesh_role");
      server.close((error) => error ? reject(error) : resolve());
    } catch (error) {
      server.close(() => reject(error));
    }
  });
});

assert.ok(checks === 38, `cpn-renew-config smoke ran ${checks} checks, expected 38`);
console.log(`\ncpn-renew-config smoke: ${checks} checks OK`);
