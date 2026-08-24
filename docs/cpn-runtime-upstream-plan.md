# Kubernetes runtime upstream decomposition

The CPN deployment uses Cotal's ordinary manager control surface: `cotal_spawn` is capability-gated,
the manager authenticates the caller and allocates the child lifecycle, and a `RuntimeProvider` submits
the external work. CPN profiles, model lanes and launcher credentials are deployment configuration,
not Cotal core policy.

Upstream this should land as small changes:

1. Allow `Runtime.spawn` to return a promise and await it at the manager's existing launch points.
   Existing workstation runtimes remain synchronous.
2. Add the generic manager-owned `RuntimeSpawnContext` (persona, resolved connector/model selectors,
   task, authenticated parent and allocated child lifecycle, correlation id) and optional remote launch
   receipt on `AgentHandle`.
3. Add the `@cotal-ai/cpn-runtime` extension with a pure server-side `CpnLaunchClient` seam. The
   composition root owns HTTP credentials, secret/enrollment transfer and Kubernetes scheduling.
4. Extend the connector `cotal_spawn` tool with the bounded optional `task` argument. The CPN runtime
   requires it; local runtimes retain the existing initial-prompt behavior.
5. Add an integration composition/example that supplies the trusted launcher client, then an E2E test:
   spawn-capable laptop and Kubernetes parents both launch a non-leaf child, receive the remote receipt,
   observe its Cotal presence, and receive its terminal result. Explicit leaf profiles omit `spawn`.

The external launcher must preserve the manager-issued child lifecycle through a server-side enrollment
or immutable job secret. It must not mint a parallel Cotal identity, and no ordinary agent receives the
launcher bearer or bootstrap secret.
