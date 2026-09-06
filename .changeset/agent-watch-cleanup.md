---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Replace authenticated agents' generated public-KV watch consumers with trusted-provisioned,
lifecycle-owned consumers whose push destinations are fixed before the agent connects. Agent
credentials can bind, acknowledge, and delete only those exact presence and channel watchers; they
cannot use consumer create or pull replies to relay permitted KV bytes onto a foreign private inbox.
The user-auth service ensures the interactive CLI actor's fixed watchers before releasing a bearer
and preserves canonical push-bound consumers across overlapping commands and bearer refreshes. It
replaces every unbound consumer because post-crash traffic can make an abandoned watcher pending;
simultaneous lifecycle ensures are coalesced, and the fixed name and rail let the next CLI process
bind the replacement and receive a fresh current-state snapshot.
