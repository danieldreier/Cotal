/** Focused protocol smoke for the transport-neutral Cotal MCP server. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  EmptyResultSchema,
  ResourceUpdatedNotificationSchema,
  type ResourceUpdatedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  COTAL_CONTEXT_URI,
  COTAL_INBOX_URI,
  createCotalMcpServer,
  type AgentConfig,
  type MeshAgent,
} from "../src/index.js";

const config = {
  space: "mcp-smoke",
  name: "alice",
  role: "operator",
  id: "alice-id",
  servers: "nats://127.0.0.1:4222",
  subscribe: ["general"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  kind: "agent",
  tls: false,
} as AgentConfig;

const ep = new EventEmitter();
const item = {
  id: "message-1",
  recvKey: "message-1",
  ts: 1,
  fromId: "bob-id",
  fromName: "bob",
  fromRole: "worker",
  kind: "dm" as const,
  mentions: [],
  mentionsMe: false,
  historical: false,
  text: "hello",
} as never;
let drainCalls = 0;
const agent = Object.assign(new EventEmitter(), {
  ep,
  id: "alice-id",
  status: "idle" as const,
  attention: "open" as const,
  connected: true,
  roster: () => [],
  inboxCount: () => 1,
  peekInbox: () => [item],
  drainInboxDeliveries: () => { drainCalls++; throw new Error("resource must never drain"); },
}) as unknown as MeshAgent;

const server = createCotalMcpServer(agent, config, "smoke");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "mcp-server-smoke", version: "0.0.0" });
const updates: ResourceUpdatedNotification[] = [];
client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
  updates.push(notification);
});
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

try {
  const listed = await client.listResources();
  assert.deepEqual(new Set(listed.resources.map((resource) => resource.uri)), new Set([COTAL_CONTEXT_URI, COTAL_INBOX_URI]));
  assert.deepEqual((await client.getServerCapabilities()).resources, { listChanged: true, subscribe: true });

  const context = await client.readResource({ uri: COTAL_CONTEXT_URI });
  assert.equal(context.contents[0]?.mimeType, "application/json");
  assert.equal(JSON.parse(context.contents[0]?.text ?? "").identity.name, "alice");

  const inbox = await client.readResource({ uri: COTAL_INBOX_URI });
  assert.equal(inbox.contents[0]?.mimeType, "text/plain");
  assert.match(inbox.contents[0]?.text ?? "", /hello/);
  assert.equal(drainCalls, 0, "forced-peek resource must not acknowledge messages");

  await client.request({ method: "resources/subscribe", params: { uri: COTAL_INBOX_URI } }, EmptyResultSchema);
  await server.cotalResources.notify(COTAL_CONTEXT_URI);
  assert.equal(updates.length, 0, "subscription is URI-scoped");
  agent.emit("incoming", item);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(updates.map((notification) => notification.params.uri), [COTAL_INBOX_URI]);

  await client.request({ method: "resources/unsubscribe", params: { uri: COTAL_INBOX_URI } }, EmptyResultSchema);
  await assert.rejects(
    client.request({ method: "resources/subscribe", params: { uri: "cotal://not-registered" } }, EmptyResultSchema),
    /does not support subscriptions/,
  );
  await server.cotalResources.notify(COTAL_INBOX_URI);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 1, "unsubscribe must stop notifications");
} finally {
  server.cotalResources.close();
  await client.close();
  await server.close();
}

console.log("MCP SERVER SMOKE OK ✅");
