import type { Extension } from "./registry.js";
import type { LaunchSpec } from "./connector.js";

/** Which backend a manager spawns through. Open-ended: `pty` ships with the manager; every other
 *  name is contributed by a {@link RuntimeProvider}. */
export type RuntimeKind = string;

/** A live attach onto a running agent's terminal — the stream `cotal attach`
 *  (and, later, the browser console) consumes. PTY frames flow here directly,
 *  never over the mesh. */
export interface AttachSession {
  readonly cols: number;
  readonly rows: number;
  /** A snapshot to bootstrap a late/concurrent attach: bytes that repaint the current screen.
   *  May be async — a backend can reconstruct a full-screen (alternate-screen) TUI's buffer rather
   *  than replay raw scrollback, so an attach paints correctly without the child having to repaint. */
  backlog(): Buffer | Promise<Buffer>;
  /** Subscribe to live output; returns an unsubscribe fn. */
  onData(fn: (chunk: Buffer) => void): () => void;
  /** Fires when the underlying process exits; returns an unsubscribe fn. */
  onExit(fn: () => void): () => void;
  /** Forward keystrokes to the process. */
  write(data: string): void;
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): void;
}

/** An OS handle on one spawned agent — the manager owns this to *control* the
 *  process (the mesh observes its presence separately). */
export interface AgentHandle {
  readonly name: string;
  readonly kind: RuntimeKind;
  /** OS pid of the spawned child, when the backend owns a real process (pty/host); absent for
   *  backends that don't (tmux/cmux attach to an externally-owned process). */
  readonly pid?: number;
  /** An external runtime's authoritative launch receipt. This is deliberately small and free of
   *  credentials: managers surface it in the spawn outcome so a caller can correlate a remote
   *  job with its mesh child without receiving the runtime's control credential. */
  readonly remote?: { id: string; status: string; taskId?: string };
  status(): "running" | "exited";
  /** Tear the agent down. `graceful` (default) signals a clean exit (so the session
   *  leaves the mesh on its own) before ensuring the process/tab is gone; otherwise
   *  it's a hard, immediate kill. */
  stop(opts?: { graceful?: boolean }): void;
  /** Resolve only after the runtime has authoritatively proved the process/window/workspace is gone.
   * Optional during the preservation rollout; a manager maintenance cut must fail closed when absent. */
  waitForExit?(): Promise<void>;
  interrupt(): void;
  /** Type `data` into the agent as if it came from the keyboard: the one-shot sibling of
   *  {@link interrupt} (which already writes `\x03`). A caller that wants to deliver a line of
   *  text, not to watch a terminal, uses this instead of standing up an {@link AttachSession} for
   *  it: a session carries a backlog, a subscriber set and a lifetime, and none of that is wanted
   *  for one write.
   *
   *  OPTIONAL, and absent means REFUSE, never degrade: a backend that does not own the child's
   *  input stream (tmux/cmux/orca/herdr attach to an externally-owned process) leaves it off, and
   *  the manager answers `input is not supported by runtime <kind>`. A silent no-op here would be
   *  a dropped keystroke, which is worse than an error. */
  write?(data: string): void;
  /** Open a live attach. Throws on backends that can't stream (e.g. tmux/cmux, which
   *  you attach to natively). */
  attach(): AttachSession;
}

/** A pluggable agent backend — `pty` (default) owns a real pseudo-terminal; extension runtimes
 *  can delegate to an external terminal or process surface. */
export interface Runtime {
  readonly kind: RuntimeKind;
  /** A runtime may need to await an external scheduler's admission before it can hand the manager
   *  a handle. Existing workstation runtimes remain synchronous. */
  spawn(name: string, spec: LaunchSpec, cwd: string, context?: RuntimeSpawnContext): AgentHandle | Promise<AgentHandle>;
}

/** Manager-owned context for a runtime launch. It is not agent-controlled launch options: the
 * manager derives it after authenticating the caller and allocating the child incarnation. Remote
 * runtimes use it to preserve parent/child lineage without parsing credentials or local paths. */
export interface RuntimeSpawnContext {
  persona: string;
  task?: string;
  /** Manager-resolved connector and model selectors; remote runtimes never reverse-engineer these
   * from a command line or child environment. */
  agent: string;
  model?: string;
  variant?: string;
  /** Action request id when this was accepted through the manager service. */
  correlationId?: string;
  parent: { principal: string; lifecycleUid?: string };
  child: { principal: string; lifecycleUid: string };
}

/**
 * A bridge that contributes one runtime backend — an {@link Extension} of kind
 * `"runtime"`. `name` is the backend it provides (e.g. `"cmux"`), the key the
 * manager resolves by. Providers self-register on import (like {@link Connector}),
 * so the manager core stays ignorant of which runtimes exist beyond its built-ins.
 */
export interface RuntimeProvider extends Extension {
  readonly kind: "runtime";
  readonly name: RuntimeKind;
  /** Whether this backend is reachable right now (e.g. the cmux app is running). */
  available(): boolean;
  /** Build a runtime instance. `session` names a per-space multiplexer session
   *  when the backend uses one (tmux); others may ignore it. */
  create(opts: { session: string }): Runtime;
}
