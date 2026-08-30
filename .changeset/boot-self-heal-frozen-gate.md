---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

A manager that died mid-registration left the issuance gate frozen, and the successor refused to
register until an operator ran `cotal reconcile-gate`. Boot now completes that same dead
registration itself when the freeze-holder is affirmatively gone under a complete CONNZ sweep
(`gone` and `sweepComplete=true`), then continues the normal takeover. Live, unknown,
unestablishable, wrong-op-kind, lost successor lease tenure, and a raced final reopen still refuse;
there is no TTL. The automatic path re-proves its own manager lease around every mutating phase.
A raced reopen is the one refusal raised after the repair has already revoked the credential family
and evicted its holders, so it now names those side effects instead of reporting that nothing
happened — the race winner may have been disconnected mid-registration and an operator has to know.
