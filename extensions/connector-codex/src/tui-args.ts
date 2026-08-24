/**
 * Arguments a laptop wrapper may append to the managed Codex TUI launch.
 *
 * The value is JSON rather than a shell fragment so each array item remains one argv token,
 * including spaces and characters a shell would otherwise reinterpret.
 */
export const CODEX_TUI_ARGS_ENV = "COTAL_CODEX_TUI_ARGS_JSON";

/** Flags that would let a wrapper select a different session or remote app-server. */
const MANAGED_FLAGS: ReadonlyMap<string, string> = new Map([
  ["--remote", "the app-server endpoint"],
  ["--remote-auth-token-env", "the app-server auth-token environment variable"],
  ["--remote-auth-token", "the app-server auth token"],
  ["--last", "the managed thread"],
  ["--all", "the managed thread"],
  ["--include-non-interactive", "the managed thread"],
  ["--resume", "the managed thread"],
  ["--session", "the managed thread"],
  ["--session-id", "the managed thread"],
  ["--thread", "the managed thread"],
  ["--thread-id", "the managed thread"],
  ["--fork", "the managed thread"],
]);

/** Validate already-decoded wrapper arguments without changing their order or values. */
export function validateCodexTuiArgs(args: readonly string[]): void {
  // Refuse these names anywhere in the array. A wrapper must not be able to smuggle a second
  // endpoint or session selector after a `--` sentinel and rely on a Codex parser detail.
  for (const arg of args) {
    const equals = arg.indexOf("=");
    const name = arg.startsWith("--") ? arg.slice(0, equals >= 0 ? equals : arg.length) : arg;
    const owner = MANAGED_FLAGS.get(name);
    if (owner !== undefined)
      throw new Error(`${CODEX_TUI_ARGS_ENV} contains ${JSON.stringify(arg)}, which is reserved: Cotal owns ${owner}`);
  }
}

/** Decode and validate the wrapper's JSON-array environment value. */
export function parseCodexTuiArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${CODEX_TUI_ARGS_ENV} must be a JSON array of argument strings`);
  }
  if (!Array.isArray(parsed))
    throw new Error(`${CODEX_TUI_ARGS_ENV} must be a JSON array of argument strings`);
  for (const arg of parsed) {
    if (typeof arg !== "string")
      throw new Error(`${CODEX_TUI_ARGS_ENV} must contain only strings (got ${arg === null ? "null" : typeof arg})`);
  }
  validateCodexTuiArgs(parsed);
  return parsed;
}
