/**
 * Live Codex Agent Skill discovery smoke. This deliberately does not configure an MCP server or
 * start a Cotal host: a fresh `codex exec` must load the installed cross-vendor skill from
 * `~/.agents/skills` and return its marker in plain text. It is therefore not a tools/list or
 * cotal_* MCP discovery test.
 *
 * Run: COTAL_E2E_CODEX=1 pnpm smoke:codex-skill-live
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_CODEX ?? "")) {
  console.log("SKIP codex skill live E2E — set COTAL_E2E_CODEX=1 (needs an authenticated `codex` CLI) to run it");
  process.exit(0);
}

const codex = process.env.COTAL_CODEX_BIN ?? "codex";
const probe = spawnSync(codex, ["--version"], { encoding: "utf8" });
if (probe.status !== 0) throw new Error(`codex skill live E2E requires an executable codex CLI: ${probe.stderr || probe.error?.message || "not found"}`);

const originalHome = process.env.HOME ?? homedir();
const originalUserProfile = process.env.USERPROFILE;
const originalCotalHome = process.env.COTAL_HOME;
const root = mkdtempSync(join(tmpdir(), "cotal-codex-skill-live-"));
const home = join(root, "home");
const codexHome = join(home, ".codex");
const cotalHome = join(home, ".cotal");
const project = join(root, "project");
const artifactDir = process.env.COTAL_E2E_ARTIFACT_DIR;
mkdirSync(home, { recursive: true });
mkdirSync(codexHome, { recursive: true });
mkdirSync(cotalHome, { recursive: true });
mkdirSync(project, { recursive: true });

// A ChatGPT-plan auth file is linked, never copied, when no API key was supplied. The test never
// reads or prints it; this mirrors the connector's private CODEX_HOME contract while keeping the
// temporary HOME available for the actual Agent Skills search.
if (!process.env.OPENAI_API_KEY) {
  const authSource = process.env.COTAL_E2E_CODEX_AUTH ?? join(originalHome, ".codex", "auth.json");
  if (!existsSync(authSource)) throw new Error(`no Codex authentication found; set OPENAI_API_KEY or COTAL_E2E_CODEX_AUTH (expected ${authSource})`);
  symlinkSync(authSource, join(codexHome, "auth.json"));
}

try {
  const skillHome = join(home, ".agents", "skills");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.COTAL_HOME = cotalHome;
  const { installAgentSkills } = await import("../../../implementations/cli/src/lib/agent-skills.js");
  installAgentSkills();

  const skill = readFileSync(join(skillHome, "cotal-mesh", "SKILL.md"), "utf8");
  assert.match(skill, /Discovery marker: mesh edges are contracts, not vibes\./, "canonical cotal-mesh skill is installed");

  const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
  if (git.status !== 0) throw new Error(`could not create isolated Codex project: ${git.stderr}`);
  const last = join(root, "last-message.txt");
  const prompt = "Read the available Agent Skills for this request. Without using shell, MCP, or any other tool, report the exact discovery marker from the cotal-mesh skill. If no such skill is available, reply SKILL_NOT_DISCOVERED.";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    COTAL_HOME: cotalHome,
  };
  const run = spawnSync(codex, [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--sandbox",
    "read-only",
    "--cd",
    project,
    "-o",
    last,
    prompt,
  ], { encoding: "utf8", env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (run.error) throw run.error;
  assert.equal(run.status, 0, `fresh Codex session failed: ${output.slice(-2000)}`);
  const answer = readFileSync(last, "utf8");
  assert.match(answer, /Discovery marker: mesh edges are contracts, not vibes\./, "fresh Codex session loaded cotal-mesh");
  assert.doesNotMatch(output, /cotal_(?:orientation|roster|send|dm|inbox|docs)\b/i, "no Cotal MCP tool was called");
  assert.doesNotMatch(output, /\b(?:mcp|tool_call|function_call)\b/i, "skill proof did not use MCP/tool discovery");

  if (artifactDir) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "codex-skill-live.jsonl"), run.stdout ?? "");
    writeFileSync(join(artifactDir, "codex-skill-live-answer.txt"), answer);
  }
  console.log("codex-skill-live.smoke: fresh session loaded cotal-mesh without MCP discovery");
} finally {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalCotalHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = originalCotalHome;
  if (!artifactDir) rmSync(root, { recursive: true, force: true });
}
