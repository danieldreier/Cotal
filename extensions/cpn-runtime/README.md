# CPN runtime

`@cotal-ai/cpn-runtime` is a Cotal `RuntimeProvider` for a Kubernetes-backed CPN launcher.
Importing it registers runtime `cpn`. A production manager configures the provider with
`COTAL_CPN_LAUNCHER_URL`, `COTAL_CPN_LAUNCHER_TOKEN_FILE`, and
`COTAL_CPN_LAUNCHER_PROFILES`; `configureCpnLauncher()` remains a test/custom-composition seam.

The provider accepts only personas listed in `COTAL_CPN_LAUNCHER_PROFILES`, for example:

```json
[{"persona":"codex-terra","profile":"codex-terra","lane":"terra","agent":"codex","model":"gpt-5.6-terra","variant":"high","taskClass":"general"}]
```

Reviewed CPN worker personas supply role `helper`. Callers should omit the optional
`cotal_spawn.role` override; the provider refuses any explicit non-helper role before it contacts
the launcher. Generic Cotal runtimes retain their normal role-override behavior.

The manager, not the agent, supplies the authenticated parent lifecycle, child lifecycle, resolved
connector/model selectors, bounded task and action correlation ID. The provider reads the manager's
already-minted child credential from `COTAL_LAUNCH_MATERIAL` and sends it only to the launcher's
manager-only endpoint. For a static mesh it converts the manager's bare child NKey into the
canonical `local.<NKey>` principal used by launcher lineage and adoption. It also carries the
manager-resolved persona body because a remote worker
cannot dereference the manager's local `.cotal/agents` path. The client returns
`{jobId, taskId, status}`; Cotal carries that receipt in
the spawn goal outcome.

The manager bearer is read from the configured file, never an environment value. The client polls
`GET /v1/manager/jobs/<task-id>` and uses `DELETE` on the same route for authoritative lifecycle
control. A terminal or absent Job resolves `AgentHandle.waitForExit()` and fires late or live exit
subscribers, so Cotal can reap hierarchy and credentials correctly. Ordinary agents receive neither
the manager bearer nor child bootstrap material.

CPN personas are one-shot worker personas: `cotal_spawn` must include a task. Host-session resume,
interactive terminal input, and interrupt are deliberately unsupported; stop and Job exit are
supported and authoritative. The manager does not require the model client's executable locally:
it resolves the connector and builds its identity/persona material, while the reviewed Kubernetes
worker image owns the actual Codex, Claude Code, or OpenCode executable.
