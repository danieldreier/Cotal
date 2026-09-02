---
"@cotal-ai/core": patch
---

Replace authenticated agents' generated public-KV watch consumers with stable lifecycle-owned
consumers. Their credentials can create, inspect, and delete only those exact presence and channel
watchers, so reconnect and stop cleanup work without granting authority over a peer consumer.
