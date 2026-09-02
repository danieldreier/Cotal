// Validates that CPN credential renewal arms on exactly the environment that can drive it, refuses a
// half-configured launch loudly instead of degrading, and leaves an unconfigured launch untouched.
//
// Pure table test: no broker, no network, no filesystem. The subject is resolveCpnRenewal, the one
// function that decides whether a session renews its own launcher-minted credential.
import { strict as assert } from "node:assert";
import { resolveCpnRenewal, RENEW_INTERVAL_DEFAULT_SECONDS, type CpnRenewalInputs } from "../src/cpn-renew.js";

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

assert.ok(checks === 16, `cpn-renew-config smoke ran ${checks} checks, expected 16`);
console.log(`\ncpn-renew-config smoke: ${checks} checks OK`);
