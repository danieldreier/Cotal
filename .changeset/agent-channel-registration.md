---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

Authenticated agents can now create and join a channel with `cotal_channel_create` when its name
is inside their read and post ACLs. Registration is mediated server-side and create-only: agents
keep read-only registry credentials, the registrar re-checks the durable read ACL, and an existing
channel card is never overwritten.

The same shared tool surface is rendered by the Claude Code, Codex, and OpenCode connectors. One
session can create or join multiple project/shared channels without being reissued credentials when
its ACL grants the containing wildcard namespace.
