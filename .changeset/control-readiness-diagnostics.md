---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Add a bounded read-only manager-control readiness tool and preserve whether an unanswered endpoint
call was broker-confirmed to have zero subscribers or merely reached its reply deadline. Connector
errors now classify the first as not executed and the second as unknown, with stalled-handler
guidance that does not invite an unsafe spawn retry. Spawn-capable credentials gain only the exact
`manager.status` request row needed by the advertised readiness probe, not the wider manager-read
family.
