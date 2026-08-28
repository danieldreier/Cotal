---
"@cotal-ai/connector-core": patch
---

Expose an optional bounded `task` on `cotal_spawn` and carry it through the manager's existing initial-prompt contract. Remote runtimes can require the task while generic local Cotal spawning remains backward compatible.
