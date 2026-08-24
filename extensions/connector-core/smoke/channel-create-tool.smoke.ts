/**
 * The shared connector tool must turn one model request into create-then-join, while refusing names
 * outside either ACL before any effect. Claude Code, Codex and OpenCode all render this same spec.
 *
 * Run: pnpm smoke:channel-create-tool
 */
import assert from "node:assert/strict";
import { configFromEnv, type AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { MeshAgent } from "../src/agent.js";

const config = (post = "project.>"): AgentConfig =>
  configFromEnv({
    COTAL_NAME: "creator",
    COTAL_SPACE: "tool-create",
    COTAL_SERVERS: "nats://127.0.0.1:4222",
    COTAL_SUBSCRIBE: "general",
    COTAL_ALLOW_SUBSCRIBE: "general,project.>",
    COTAL_ALLOW_PUBLISH: post,
  });

const toolFor = (cfg: AgentConfig) => {
  const spec = cotalToolSpecs(cfg).find((s) => s.name === "cotal_channel_create");
  assert.ok(spec, "cotal_channel_create is present on the shared tool surface");
  return spec;
};
const tool = toolFor(config());

const calls: string[] = [];
const agent = {
  registerChannel: async (channel: string, description?: string) => {
    calls.push(`register:${channel}:${description ?? ""}`);
    return { channel, created: true };
  },
  joinChannel: async (channel: string) => {
    calls.push(`join:${channel}`);
    return { joined: true, backfilled: 0, durable: true };
  },
} as unknown as MeshAgent;

const made = await tool.run(agent, config(), {
  channel: "project.cpn",
  description: "CPN coordination",
});
assert.equal(made.isError, undefined);
assert.match(made.text, /Created #project\.cpn; joined/);
assert.deepEqual(calls, ["register:project.cpn:CPN coordination", "join:project.cpn"]);

calls.length = 0;
const outsideRead = await tool.run(agent, config(), { channel: "secret", description: "no" });
assert.equal(outsideRead.isError, true);
assert.match(outsideRead.text, /outside your read ACL/);
assert.deepEqual(calls, [], "read-ACL refusal precedes registration");

calls.length = 0;
const postScoped = config("project.docs");
const outsidePost = await toolFor(postScoped).run(agent, postScoped, {
  channel: "project.cpn",
});
assert.equal(outsidePost.isError, true);
assert.match(outsidePost.text, /outside your post ACL/);
assert.deepEqual(calls, [], "post-ACL refusal precedes registration");

calls.length = 0;
const wildcard = await tool.run(agent, config(), { channel: "project.>" });
assert.equal(wildcard.isError, true);
assert.match(wildcard.text, /concrete name/);
assert.deepEqual(calls, [], "wildcard refusal precedes registration");

console.log("CHANNEL-CREATE-TOOL SMOKE OK ✅");
