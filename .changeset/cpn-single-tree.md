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
