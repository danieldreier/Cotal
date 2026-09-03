---
"@cotal-ai/core": patch
---

Replace authenticated agents' generated public-KV watch consumers with trusted-provisioned,
lifecycle-owned consumers whose push destinations are fixed before the agent connects. Agent
credentials can bind, acknowledge, and delete only those exact presence and channel watchers; they
cannot use consumer create or pull replies to relay permitted KV bytes onto a foreign private inbox.
