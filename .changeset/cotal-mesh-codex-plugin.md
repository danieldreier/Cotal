---
"@cotal-ai/cli": patch
"@cotal-ai/mcp": patch
---

Ship the portable `cotal-engineering` skill alongside mesh coordination and team-topology guidance.
Add the repository-local `cotal-mesh` Codex plugin, which bundles those skills with Cotal's trusted
local MCP declaration and validates the real Codex marketplace installation path. Seed the local MCP
gateway with the CLI so a newly installed plugin can run `cotal mcp` without a separate extension step.
For the CPN personal plugin, that gateway now creates its own loopback tunnels and fresh launcher-issued
identity instead of resolving a local mesh.
