/**
 * Structural contract for the Cotal Mesh Codex plugin. This is deliberately a local file test:
 * the companion `smoke:codex-plugin-live` proves Codex's real marketplace/runtime path. Keeping
 * the portable bundle and CLI's canonical skill distribution byte-identical here makes a release
 * fail before either client can drift to a different instruction set.
 *
 * Run: pnpm smoke:plugin-bundle
 */
import { strict as assert } from "node:assert";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pluginDir = join(ROOT, "plugins", "cotal-mesh");
const sourceSkillsDir = join(ROOT, "implementations", "cli", "cotal-skills", "skills");
const marketplacePath = join(ROOT, ".agents", "plugins", "marketplace.json");

type PluginManifest = {
  name: string;
  version: string;
  description: string;
  skills: string;
  mcpServers: string;
  interface: { displayName: string; category: string; defaultPrompt: string[] };
};

const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const names = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

assert.ok(existsSync(pluginDir), "Cotal Mesh plugin directory exists");
assert.ok(existsSync(sourceSkillsDir), "CLI canonical skill bundle exists");
assert.ok(existsSync(marketplacePath), "repo-local Codex marketplace exists");

const manifest = json<PluginManifest>(join(pluginDir, ".codex-plugin", "plugin.json"));
assert.equal(manifest.name, "cotal-mesh");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "plugin version is publishable semver");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.mcpServers, "./.mcp.json");
assert.equal(manifest.interface.displayName, "Cotal Mesh");
assert.equal(manifest.interface.category, "Productivity");
assert.equal(manifest.interface.defaultPrompt.length, 3);
assert.ok(manifest.interface.defaultPrompt.some((prompt) => prompt.includes("$cotal-mesh")));
assert.ok(manifest.interface.defaultPrompt.some((prompt) => prompt.includes("$team-topology")));
assert.ok(manifest.interface.defaultPrompt.some((prompt) => prompt.includes("$cotal-engineering")));

const mcp = json<Record<string, unknown>>(join(pluginDir, ".mcp.json"));
assert.deepEqual(mcp, { cotal: { command: "cotal", args: ["mcp", "--cpn"] } }, "personal plugin selects CPN enrollment without baking an endpoint or secret into Codex");

const expectedSkills = ["cotal-engineering", "cotal-mesh", "team-topology"];
assert.deepEqual(names(sourceSkillsDir), expectedSkills, "CLI canonical skills are exactly the portable Cotal bundle");
assert.deepEqual(names(join(pluginDir, "skills")), expectedSkills, "plugin contains every portable canonical skill and nothing deployment-specific");

for (const name of expectedSkills) {
  const canonical = join(sourceSkillsDir, name, "SKILL.md");
  const bundled = join(pluginDir, "skills", name, "SKILL.md");
  assert.equal(lstatSync(bundled).isSymbolicLink(), false, `${name} is a real released file, not a source-tree link`);
  assert.deepEqual(readFileSync(bundled), readFileSync(canonical), `${name} plugin bytes match the CLI's canonical source`);
}

for (const name of ["cotal-engineering", "cotal-mesh"]) {
  const canonical = join(sourceSkillsDir, name, "agents", "openai.yaml");
  const bundled = join(pluginDir, "skills", name, "agents", "openai.yaml");
  assert.deepEqual(readFileSync(bundled), readFileSync(canonical), `${name} Codex metadata stays in sync`);
}

const engineering = readFileSync(join(sourceSkillsDir, "cotal-engineering", "SKILL.md"), "utf8");
assert.match(engineering, /^name:\s+cotal-engineering\s*$/m);
assert.doesNotMatch(engineering, /\/Users\/|CPN|Kubernetes|kubectl|cotal-maintainer/i, "portable engineering guide contains no owner- or deployment-specific operating instructions");

const marketplace = json<{ name: string; plugins: Array<{ name: string; source: { source: string; path: string }; policy: { installation: string; authentication: string }; category: string }> }>(marketplacePath);
assert.equal(marketplace.name, "personal");
assert.deepEqual(marketplace.plugins, [
  {
    name: "cotal-mesh",
    source: { source: "local", path: "./plugins/cotal-mesh" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  },
]);

console.log("plugin-bundle.smoke: portable Cotal skills, marketplace, and local stdio MCP declaration are consistent");
