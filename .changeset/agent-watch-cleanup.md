---
"@cotal-ai/core": patch
---

Let agent credentials delete their generated ordered consumers on only the public presence and
channel-registry KV streams they already watch. This makes nats.js reset and stop cleanup usable
without granting another KV bucket, a stream delete, or record mutation.
