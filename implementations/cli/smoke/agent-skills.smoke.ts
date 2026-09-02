/**
 * Smoke for the cross-vendor `~/.agents/skills` and Codex-native `~/.codex/skills` reconciles
 * (lib/agent-skills.ts). Exercises the destructive/adversarial paths in throwaway HOME/COTAL_HOME
 * dirs: fresh install, ownership-aware backup (including a SECOND edit), file-level retirement that
 * spares a user's files and empties, the skew states, the symlink-escape guard (incl. a nested
 * SKILL.md symlink), the hard-linked-SKILL.md clobber guard, fresh-slot backups that never destroy a
 * pre-existing/foreign `.bak`, the manifest-temp symlink-clobber guard, and manifest integrity
 * (traversal-key rejection, array-shape rejection, corrupt-JSON fail-loud). Run: pnpm smoke:agent-skills
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");
const created: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

/** Point HOME + COTAL_HOME at fresh throwaway dirs so each block starts with empty cross-vendor and
 *  Codex skill roots plus an empty ownership manifest. The lib reads homedir()/COTAL_HOME at call time,
 *  so this rebinds cleanly. */
function freshEnv() {
  const home = mkdtempSync(join(tmpdir(), "cs-home-"));
  const cotalHome = mkdtempSync(join(tmpdir(), "cs-cotal-"));
  created.push(home, cotalHome);
  process.env.HOME = home;
  process.env.USERPROFILE = home; // win32 homedir()
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.COTAL_HOME = cotalHome;
  return { home, cotalHome, manifest: join(cotalHome, "agent-skills.json") };
}

const lib = await import("../src/lib/agent-skills.js");
const { agentSkillsHome, canonicalSkillsDir, canonicalSkillNames, codexSkillsHome, codexSkillsSkew, installAgentSkills, agentSkillsSkew } = lib;

try {
  const canon = canonicalSkillsDir();
  const names = canonicalSkillNames();
  assert.deepEqual(names, ["cotal-engineering", "cotal-mesh", "team-topology"], "the shipped cross-vendor skill set is deterministic");
  const meshSkill = readFileSync(join(canon, "cotal-mesh", "SKILL.md"), "utf8");
  assert.match(meshSkill, /^name:\s+cotal-mesh\s*$/m);
  assert.match(meshSkill, /^description:\s+.+Cotal.+cotal_\* tools.+$/m);
  assert.match(meshSkill, /Discovery marker: mesh edges are contracts, not vibes\./);
  const name = names[0]; // cotal-mesh: exercise installation and safety with the mesh skill itself
  const canonicalBytes = readFileSync(join(canon, name, "SKILL.md"));
  const stateOf = (n: string) => agentSkillsSkew().find((s) => s.name === n)?.state;
  const codexStateOf = (n: string) => codexSkillsSkew().find((s) => s.name === n)?.state;

  // --- Block 1: install / backup / retirement / skew -----------------------------------------------
  {
    const { manifest } = freshEnv();
    const skillsHome = agentSkillsHome();
    const destFile = join(skillsHome, name, "SKILL.md");
    const codexDestFile = join(codexSkillsHome(), name, "SKILL.md");
    const codexInterface = join(codexSkillsHome(), name, "agents", "openai.yaml");
    const bak = `${destFile}.bak`;
    const readManifest = () => JSON.parse(readFileSync(manifest, "utf8")) as { skills: Record<string, string> };
    const writeManifest = (m: { skills: Record<string, string> }) => writeFileSync(manifest, JSON.stringify(m));
    const own = (n: string, body: string) => {
      mkdirSync(join(skillsHome, n), { recursive: true });
      writeFileSync(join(skillsHome, n, "SKILL.md"), body);
      const m = readManifest();
      m.skills[n] = sha(body);
      writeManifest(m);
    };

    // fresh install
    assert.equal(stateOf(name), "missing");
    let r = installAgentSkills();
    assert.deepEqual([r.installed, r.backedUp, r.removed], [names, [], []]);
    assert.deepEqual([r.codexInstalled, r.codexBackedUp, r.codexRemoved], [names, [], []]);
    assert.deepEqual([r.codexInterfacesInstalled, r.codexInterfacesBackedUp, r.codexInterfacesRemoved], [["cotal-engineering", "cotal-mesh"], [], []]);
    assert.equal(stateOf(name), "current");
    assert.equal(codexStateOf(name), "current");
    assert.ok(readFileSync(destFile).equals(canonicalBytes));
    assert.ok(readFileSync(codexDestFile).equals(canonicalBytes), "Codex gets its native skill root");
    assert.match(readFileSync(codexInterface, "utf8"), /allow_implicit_invocation: true/, "Codex gets Cotal's native skill metadata");

    // first user edit -> backed up to a fresh `.bak`
    writeFileSync(destFile, "EDIT-A");
    r = installAgentSkills();
    assert.deepEqual(r.backedUp.map((b) => b.name), [name]);
    assert.equal(readFileSync(bak, "utf8"), "EDIT-A");
    assert.equal(r.backedUp[0].path, bak, "result names the exact backup path");

    // SECOND user edit -> a NEW backup slot; the earlier backup is NOT destroyed (round-4 finding: a
    // rename-over-`.bak` clobbered the previous backup). Both edits stay recoverable.
    writeFileSync(destFile, "EDIT-B");
    r = installAgentSkills();
    assert.deepEqual(r.backedUp.map((b) => b.name), [name]);
    assert.equal(r.backedUp[0].path, `${bak}.1`, "result names the fresh slot, not the occupied .bak");
    assert.equal(readFileSync(bak, "utf8"), "EDIT-A", "the earlier backup is preserved");
    assert.equal(readFileSync(`${bak}.1`, "utf8"), "EDIT-B", "the latest edit is recoverable in a fresh slot");

    // no-op re-run
    r = installAgentSkills();
    assert.deepEqual([r.backedUp, r.removed], [[], []]);

    // retirement spares a user's file and keeps the dir (round-2 finding: whole-dir rmSync ate user data)
    own("retired-userfile", "ours");
    writeFileSync(join(skillsHome, "retired-userfile", "notes.md"), "USER NOTES");
    r = installAgentSkills();
    assert.ok(r.removed.includes("retired-userfile"));
    assert.ok(!existsSync(join(skillsHome, "retired-userfile", "SKILL.md")), "our file removed");
    assert.equal(readFileSync(join(skillsHome, "retired-userfile", "notes.md"), "utf8"), "USER NOTES", "user file preserved");

    // retirement drops the dir when it is left empty
    own("retired-empty", "ours");
    r = installAgentSkills();
    assert.ok(r.removed.includes("retired-empty"));
    assert.ok(!existsSync(join(skillsHome, "retired-empty")), "empty retired dir removed");

    // a retired skill the user diverged is left entirely alone
    own("retired-diverged", "ours");
    writeFileSync(join(skillsHome, "retired-diverged", "SKILL.md"), "USER CHANGED");
    r = installAgentSkills();
    assert.ok(!r.removed.includes("retired-diverged"));
    assert.ok(existsSync(join(skillsHome, "retired-diverged", "SKILL.md")));

    // skew reports a still-present managed retired skill
    own("retired-shown", "x");
    assert.equal(stateOf("retired-shown"), "retired");
  }

  // --- Block 2: symlink-escape guard, incl. a nested SKILL.md symlink (round-2 CRITICAL) -----------
  for (const kind of ["dir", "file"] as const) {
    const { home } = freshEnv();
    const outside = mkdtempSync(join(tmpdir(), "cs-outside-"));
    created.push(outside);
    if (kind === "dir") {
      symlinkSync(outside, join(home, ".agents")); // redirected ancestor
    } else {
      mkdirSync(join(agentSkillsHome(), name), { recursive: true }); // normal dirs, but SKILL.md is a link
      const target = join(outside, "victim.txt");
      writeFileSync(target, "OUTSIDE DATA");
      symlinkSync(target, join(agentSkillsHome(), name, "SKILL.md"));
    }
    assert.throws(() => installAgentSkills(), /symlink/, `must refuse a symlinked ${kind}`);
    if (kind === "file") assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "OUTSIDE DATA", "outside file not clobbered");
    rmSync(outside, { recursive: true, force: true });
  }

  // Codex's native root receives the same redirected-ancestor defense as the cross-vendor root.
  {
    const { home } = freshEnv();
    const outside = mkdtempSync(join(tmpdir(), "cs-outside-"));
    created.push(outside);
    symlinkSync(outside, join(home, ".codex"));
    assert.throws(() => installAgentSkills(), /symlink/, "must refuse a symlinked Codex skill ancestor");
    assert.equal(readdirSync(outside).length, 0, "Codex symlink target untouched");
    rmSync(outside, { recursive: true, force: true });
  }

  // The optional Codex interface file is guarded independently; a redirected `agents/` directory
  // cannot make setup write outside the native skill root.
  {
    const { home } = freshEnv();
    const outside = mkdtempSync(join(tmpdir(), "cs-outside-"));
    created.push(outside);
    mkdirSync(join(home, ".codex", "skills", "cotal-mesh"), { recursive: true });
    symlinkSync(outside, join(home, ".codex", "skills", "cotal-mesh", "agents"));
    assert.throws(() => installAgentSkills(), /symlink/, "must refuse a symlinked Codex interface directory");
    assert.equal(readdirSync(outside).length, 0, "Codex interface symlink target untouched");
    rmSync(outside, { recursive: true, force: true });
  }

  // --- Block 3: a hard-linked SKILL.md must not clobber the outside inode (round-3 CRITICAL) -------
  {
    freshEnv();
    const skillsHome = agentSkillsHome();
    const outside = mkdtempSync(join(tmpdir(), "cs-outside-"));
    created.push(outside);
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "OUTSIDE DATA");
    mkdirSync(join(skillsHome, name), { recursive: true });
    linkSync(victim, join(skillsHome, name, "SKILL.md")); // hard link: a regular file, so it passes the symlink guard
    const before = statSync(victim).ino;
    const r = installAgentSkills();
    assert.ok(r.installed.includes(name), "install still succeeds");
    assert.equal(readFileSync(victim, "utf8"), "OUTSIDE DATA", "hard-linked outside file must not be clobbered");
    assert.ok(readFileSync(join(skillsHome, name, "SKILL.md")).equals(canonicalBytes), "our SKILL.md holds canonical content");
    assert.notEqual(statSync(join(skillsHome, name, "SKILL.md")).ino, before, "our SKILL.md is a fresh inode, not the shared one");
  }

  // --- Block 4: manifest traversal key is rejected, nothing deleted (round-2 HIGH) ----------------
  {
    const { home, manifest } = freshEnv();
    const victim = join(home, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "important.txt"), "KEEP ME");
    writeFileSync(manifest, JSON.stringify({ skills: { "../../victim": sha("x") } }));
    assert.throws(() => installAgentSkills(), /manifest/i, "traversal key must fail loud");
    assert.equal(readFileSync(join(victim, "important.txt"), "utf8"), "KEEP ME", "victim untouched");
  }

  // --- Block 5: a manifest whose `skills` is an ARRAY must fail loud, delete nothing (round-3 HIGH) -
  {
    const { manifest } = freshEnv();
    const skillsHome = agentSkillsHome();
    const foreign = join(skillsHome, "0"); // an array index "0" would pass the slug check
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "FOREIGN");
    writeFileSync(manifest, JSON.stringify({ skills: [sha("FOREIGN")] })); // digest of the foreign file
    assert.throws(() => installAgentSkills(), /manifest/i, "array skills must fail loud");
    assert.equal(readFileSync(join(foreign, "SKILL.md"), "utf8"), "FOREIGN", "foreign file untouched");

    writeFileSync(manifest, JSON.stringify({ skills: [] })); // empty array must also be rejected, not silently accepted
    assert.throws(() => installAgentSkills(), /manifest/i, "empty-array skills must fail loud");
  }

  // --- Block 6: corrupt manifest fails loud (round-2 HIGH) ----------------------------------------
  {
    const { manifest } = freshEnv();
    writeFileSync(manifest, "{ not json");
    assert.throws(() => installAgentSkills(), /corrupt.*manifest/i, "corrupt manifest must fail loud");
  }

  // --- Block 7: a pre-existing/foreign SKILL.md.bak is never destroyed (round-4 HIGH) -------------
  {
    freshEnv();
    const dir = join(agentSkillsHome(), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "FOREIGN SKILL"); // an unowned, divergent skill
    writeFileSync(join(dir, "SKILL.md.bak"), "PREEXISTING BACKUP"); // a foreign backup Cotal must not clobber
    const r = installAgentSkills();
    assert.ok(r.backedUp.some((b) => b.name === name));
    assert.equal(readFileSync(join(dir, "SKILL.md.bak"), "utf8"), "PREEXISTING BACKUP", "foreign .bak preserved");
    assert.equal(readFileSync(join(dir, "SKILL.md.bak.1"), "utf8"), "FOREIGN SKILL", "our backup went to a fresh slot");
    assert.ok(readFileSync(join(dir, "SKILL.md")).equals(canonicalBytes), "our SKILL.md holds canonical content");
  }

  // --- Block 8: the manifest temp must not follow a pre-planted symlink (round-4 HIGH) ------------
  {
    const { manifest } = freshEnv();
    const outside = mkdtempSync(join(tmpdir(), "cs-outside-"));
    created.push(outside);
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "OUTSIDE DATA");
    symlinkSync(victim, `${manifest}.tmp.${process.pid}`); // predictable temp path, planted before the write
    const r = installAgentSkills();
    assert.ok(r.installed.includes(name), "install still succeeds");
    assert.equal(readFileSync(victim, "utf8"), "OUTSIDE DATA", "manifest temp symlink must not clobber the outside file");
    assert.ok(existsSync(manifest), "manifest is written to its real path");
    rmSync(outside, { recursive: true, force: true });
  }

  console.log("agent-skills.smoke: all assertions passed");
} finally {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
}
