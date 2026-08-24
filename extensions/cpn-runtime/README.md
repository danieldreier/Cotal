# CPN runtime

`@cotal-ai/cpn-runtime` is a Cotal `RuntimeProvider` for a Kubernetes-backed CPN launcher.
Importing it registers runtime `cpn`; the trusted manager composition must call
`configureCpnLauncher()` with its server-side launcher client before selecting that runtime.

The provider accepts only personas listed in `COTAL_CPN_LAUNCHER_PROFILES`, for example:

```json
[{"persona":"terra-worker","profile":"codex-terra","lane":"terra","agent":"codex"}]
```

The manager, not the agent, supplies the authenticated parent lifecycle, child lifecycle, resolved
connector/model selectors, bounded task and action correlation ID. The client receives a narrow
one-shot request and returns `{jobId, taskId, status}`; Cotal carries that receipt in the spawn goal
outcome.

The trusted composition owns launcher authentication and the child enrollment secret. A launcher
must preserve the manager-issued Cotal child lifecycle through server-side enrollment or an immutable
per-job Kubernetes Secret. Do not give launcher credentials or child bootstrap material to ordinary
Cotal agents.
