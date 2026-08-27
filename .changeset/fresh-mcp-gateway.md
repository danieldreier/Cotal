---
"@cotal-ai/mcp": minor
"@cotal-ai/connector-core": patch
---

Add the self-registering `cotal mcp` stdio gateway. It provisions session-scoped least-privilege identities, requires opaque handle selection for multi-identity calls, and retires each child lifecycle on close or shutdown.
