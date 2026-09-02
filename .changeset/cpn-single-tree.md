---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/web": minor
"@cotal-ai/cmux": minor
"@cotal-ai/orca": minor
"@cotal-ai/tmux": minor
"@cotal-ai/herdr": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/mcp": minor
"@cotal-ai/pi": minor
"@cotal-ai/auth": minor
"@cotal-ai/cpn-runtime": minor
---

Single CPN tree: merge the operator MCP gateway line (`cpn/operator-mcp-spawn-task`) into the CPN
connector line (`fix/cpn-boot-self-heal-37df-20260829`). Both fork at `7cc9fc98`; the 37 overlapping
files are resolved keeping both behaviours.

`@cotal-ai/mcp` is seeded like any other official extension (`SEEDED_EXTENSIONS` in
`packages/workspace/src/official-connectors.ts`), and every released package moves to one version,
so a seeded root no longer straddles 0.27.0 connectors and a 0.33.1 gateway with the gateway's peers
symlinked into a second checkout. `@cotal-ai/cpn-runtime` joins the changeset `fixed` group for the
same reason: it is why the 0.27.0 half of that straddle existed, and outside the group the next
release would split it off again.

What the merge decided, rather than took from one side:

- `implementations/manager/src/manager.ts` keeps the CPN narrowing of the boot self-heal's benign
  refusal set, from `{not-frozen, raced}` to `{not-frozen}`. `raced` is not benign on this path:
  revoke and evict run before the reopen, so a lost final CAS can follow side effects against
  another winner, and boot must stay fail-closed. The narrowing is mutation-guarded by
  `implementations/manager/smoke/boot-self-heal-gate.smoke.ts`.
- `docs/cli.md`, `docs/control-surface.md` and `docs/run-a-mesh.md` are unions, not either side:
  the gateway line's `cotal status --components` section, remote-participant `supervise` authority
  section, `--scope supervise` ledger row, `update --self` Agent Skills clause and `supervise
  --server` default are restored alongside the CPN line's persona-`agent:` and boot-self-heal
  rewrites. The stale "Not yet enabled: registering a remote user-auth mesh currently refuses"
  banner the gateway line deleted stays deleted.
- `docs/agent-files.md` keeps both: the new `agent:` key, and the gateway sentence naming
  `connector`, `model`, `variant` and `host` as overlaid from the live session.
- The `.internal` submodule gitlink moves `e88b4376` → `b715ce4f`, taken from the gateway side.
- The connector peers move from `>=0.1.0` to `^0.34.0-cpn.1`. node-semver excludes a prerelease
  from a plain range, so `>=0.1.0` does not match `0.34.0-cpn.1` and `npm install` of the packed
  closure fails ERESOLVE.

The `-cpn.1` prerelease label is load-bearing and must survive release tooling: this branch does
not enter changesets pre mode (that is repo-wide state, not a branch's to set), so whoever runs
`changeset version` here must keep the label rather than let it resolve to a plain `0.34.0`.
