/**
 * Real Codex plugin-host acceptance. This does not fake Codex or hand-write a
 * config: a disposable Codex home adds this repository as a marketplace,
 * installs the Cotal Mesh plugin, and asks the real CLI for the resulting MCP
 * declaration. `smoke:mcp-gateway-installed:live` separately drives that
 * declared Cotal server through a packed artifact and real mesh.
 *
 * No Codex login is needed. Run: pnpm smoke:codex-plugin-live
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const pluginVersion = (JSON.parse(readFileSync(join(REPO, "plugins", "cotal-mesh", ".codex-plugin", "plugin.json"), "utf8")) as { version: string }).version;
const codex = process.env.COTAL_CODEX_BIN ?? "codex";
const probe = spawnSync(codex, ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("SKIP Codex plugin host acceptance — install Codex or set COTAL_CODEX_BIN to its executable");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "cotal-codex-plugin-"));
const home = join(root, "home");
const codexHome = join(root, "codex-home");
mkdirSync(home, { recursive: true });
mkdirSync(codexHome, { recursive: true });

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];

function run(args: string[]) {
  const result = spawnSync(codex, args, { cwd: REPO, env, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `codex ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout ?? "";
}

try {
  const marketplace = run(["plugin", "marketplace", "add", REPO, "--json"]);
  assert.match(marketplace, /"marketplaceName"\s*:\s*"personal"/);
  assert.match(marketplace, /"installedRoot"\s*:\s*"/);

  const added = run(["plugin", "add", "cotal-mesh@personal", "--json"]);
  assert.match(added, /"pluginId"\s*:\s*"cotal-mesh@personal"/);
  assert.match(added, /"installedPath"\s*:\s*"/);

  const plugins = run(["plugin", "list", "--json"]);
  assert.match(plugins, /"pluginId"\s*:\s*"cotal-mesh@personal"/);
  assert.match(plugins, /"enabled"\s*:\s*true/);

  const mcp = run(["mcp", "list", "--json"]);
  assert.match(mcp, /"name"\s*:\s*"cotal"/);
  assert.match(mcp, /"type"\s*:\s*"stdio"/);
  assert.match(mcp, /"command"\s*:\s*"cotal"/);
  assert.match(mcp, /"args"\s*:\s*\[\s*"mcp"\s*\]/);

  const config = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.match(config, /\[plugins\."cotal-mesh@personal"\]/);
  assert.doesNotMatch(config, /credential|secret|token|grant|owner|lifecycle/i, "plugin registration stores no mesh authority in Codex config");
  assert.ok(existsSync(join(codexHome, "plugins", "cache", "personal", "cotal-mesh", pluginVersion, ".mcp.json")), "Codex cached the plugin bundle it parsed");

  console.log(`codex-plugin-live.smoke: real Codex ${probe.stdout.trim()} installed cotal-mesh and registered its local Cotal stdio MCP`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
