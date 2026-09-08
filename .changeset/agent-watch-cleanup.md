---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Replace authenticated agents' generated public-KV watch consumers with trusted-provisioned,
instance-owned consumers whose push destinations are fixed before the agent connects. Agent
credentials can bind, acknowledge, and delete only those exact presence and channel watchers; they
cannot use consumer create or pull replies to relay permitted KV bytes onto a foreign private inbox.
For user-auth clients, the auth callout derives a distinct watcher UID from each validated connection
nonce and provisions that fixed-rail pair before releasing the broker JWT. Overlapping commands
therefore bind independent LastPerSubject snapshots, and a predecessor can delete only its own pair
on graceful stop. A crashed connection's pair expires by inactivity while a cold rebind receives a
fresh pair, even when ordinary traffic is pending on the abandoned consumers. Static/dev agents keep
their lifecycle-owned provisioned pair. Bound the user-auth allocation surface with a durable,
fail-closed ledger: reserve before consumer creation, retain at most 32 pairs per canonical actor
across lifecycle rotation and auth-service restart, and reclaim only after exact-name broker probes
prove both consumers gone. User-mode manager provisioning and teardown no longer allocate or grant
authority over an unused lifecycle-named watcher pair.
