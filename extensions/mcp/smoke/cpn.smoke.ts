import assert from "node:assert/strict";
import { freshCpnPrincipal } from "../src/cpn.js";
import { createMcpGatewayServer } from "../src/gateway.js";

const first = freshCpnPrincipal("leader");
const second = freshCpnPrincipal("leader");
assert.match(first, /^laptop-mcp-leader-[a-z0-9]+-[a-f0-9]{6}$/);
assert.match(second, /^laptop-mcp-leader-[a-z0-9]+-[a-f0-9]{6}$/);
assert.notEqual(first, second, "every CPN gateway identity gets a fresh principal");
assert.match(freshCpnPrincipal("helper", "pilot-codex"), /^pilot-codex-[a-z0-9]+-[a-f0-9]{6}$/);
assert.throws(() => freshCpnPrincipal("leader", "Not DNS-safe"), /DNS-safe/);

// Constructing the CPN surface must not open a tunnel, access Keychain, enroll,
// or mint an identity. Those privileged steps happen only at identity_open.
const gateway = await createMcpGatewayServer({ cpn: true });
assert.equal(gateway.space, "cpn-pilot");
await gateway.close();
console.log("CPN MCP gateway smoke OK ✅");
