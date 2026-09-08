/**
 * Durable admission ledger for user-auth public-KV watcher pairs.
 *
 * A valid bearer is intentionally reusable, while the callout connection nonce is fresh per
 * connection. Without a second boundary, one bearer can therefore turn arbitrary nonces into an
 * arbitrary number of trusted-created JetStream consumers. This ledger caps that expansion per
 * canonical actor and survives an auth-service restart. It records the allocation BEFORE broker
 * creation, so a crash can leave a conservative occupied slot but can never leave an uncounted
 * consumer. A later admission reclaims the slot only after exact-name Consumer INFO proves BOTH
 * members of the pair gone; production never needs CONSUMER.LIST.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  mkSecretDir,
  writeSecretFile,
} from "@cotal-ai/core";

const ALLOCATIONS_DIR = "watch-allocations";
const ALLOCATION_VER = 1;

/** One bearer principal may have this many concurrently retained connection-owned watcher pairs. */
export const AGENT_KV_WATCH_ALLOCATION_LIMIT = 32;

export interface AgentKvWatchAllocation {
  owner: string;
  actor: string;
  lifecycleUid: string;
  watchUid: string;
}

interface AllocationFile extends AgentKvWatchAllocation {
  ver: number;
  allocatedAt: string;
}

export interface AgentKvWatchAllocationBroker {
  /** True only when BOTH exact watcher consumers are absent. */
  pairGone(watchUid: string): Promise<boolean>;
  /** Ensure the requested exact pair exists in its canonical trusted-created shape. */
  ensurePair(): Promise<void>;
  close(): Promise<void>;
}

function allocationDir(dir: string): string {
  return join(dir, ALLOCATIONS_DIR);
}

function assertWatchUid(watchUid: string): void {
  if (!/^[0-9a-f]{32}$/.test(watchUid))
    throw new Error(`auth-service: watcher allocation UID must be 32 lowercase hex characters, got "${watchUid}"`);
}

function assertAllocation(a: AgentKvWatchAllocation): void {
  assertDerivedOwnerToken(a.owner);
  assertValidOwnerToken(a.actor);
  assertLifecycleToken(a.lifecycleUid);
  assertWatchUid(a.watchUid);
}

function allocationFilename(a: Pick<AgentKvWatchAllocation, "owner" | "actor" | "watchUid">): string {
  return `${a.owner}.${a.actor}.${a.watchUid}.json`;
}

function readAllocation(path: string): AllocationFile {
  let fd: number | undefined;
  let parsed: AllocationFile;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("watcher allocation must be a regular non-symlink file");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error("watcher allocation must be a regular non-symlink file");
    parsed = JSON.parse(readFileSync(fd, "utf8")) as AllocationFile;
  } catch (err) {
    throw new Error(`${path}: unreadable watcher allocation (${err instanceof Error ? err.message : String(err)}) - fix or remove the row; a broken allocation ledger denies watcher creation`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (parsed === null || typeof parsed !== "object" || parsed.ver !== ALLOCATION_VER)
    throw new Error(`${path}: unknown watcher-allocation version ${String((parsed as { ver?: unknown })?.ver)} (expected ${ALLOCATION_VER}) - refusing to guess at broker resource ownership`);
  assertAllocation(parsed);
  if (typeof parsed.allocatedAt !== "string" || !Number.isFinite(Date.parse(parsed.allocatedAt)))
    throw new Error(`${path}: watcher allocation has an invalid allocatedAt timestamp`);
  const expected = allocationFilename(parsed);
  if (!path.endsWith(`/${expected}`) && !path.endsWith(`\\${expected}`))
    throw new Error(`${path}: watcher allocation filename does not match its canonical actor/watch UID (expected ${expected})`);
  return parsed;
}

function listActorAllocations(dir: string, owner: string, actor: string): Array<{ path: string; row: AllocationFile }> {
  const root = allocationDir(dir);
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${root}: watcher allocation space must be a real directory, not a symlink or non-directory`);
  const rows: Array<{ path: string; row: AllocationFile }> = [];
  for (const file of readdirSync(root).filter((name) => name.endsWith(".json")).sort()) {
    const path = join(root, file);
    const row = readAllocation(path);
    if (row.owner === owner && row.actor === actor) rows.push({ path, row });
  }
  return rows;
}

function writeAllocation(dir: string, row: AgentKvWatchAllocation): void {
  assertAllocation(row);
  const root = allocationDir(dir);
  mkSecretDir(dir);
  mkSecretDir(root);
  const path = join(root, allocationFilename(row));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeSecretFile(tmp, JSON.stringify({ ver: ALLOCATION_VER, ...row, allocatedAt: new Date().toISOString() } satisfies AllocationFile, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Single-auth-service admission coordinator. The authority-plane claim permits only one serving
 * daemon; this per-actor promise chain closes async interleavings within that daemon. Different
 * actors remain independent.
 */
export class AgentKvWatchAllocationLedger {
  private readonly actorTails = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  prepare(
    allocation: AgentKvWatchAllocation,
    openBroker: () => Promise<AgentKvWatchAllocationBroker>,
  ): Promise<void> {
    assertAllocation(allocation);
    const actorKey = `${allocation.owner}.${allocation.actor}`;
    const prior = this.actorTails.get(actorKey) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.prepareLocked(allocation, openBroker));
    this.actorTails.set(actorKey, run);
    void run.finally(() => {
      if (this.actorTails.get(actorKey) === run) this.actorTails.delete(actorKey);
    }).catch(() => {});
    return run;
  }

  private async prepareLocked(
    allocation: AgentKvWatchAllocation,
    openBroker: () => Promise<AgentKvWatchAllocationBroker>,
  ): Promise<void> {
    // Open the short-lived provisioner INSIDE the actor queue. A burst of distinct nonces cannot
    // create an unbounded parallel fan-out of privileged connections while waiting for the same
    // allocation lock.
    const broker = await openBroker();
    let prepared = false;
    try {
      let rows = listActorAllocations(this.dir, allocation.owner, allocation.actor);
      let sameUid = rows.find(({ row }) => row.watchUid === allocation.watchUid);
      if (sameUid && sameUid.row.lifecycleUid !== allocation.lifecycleUid)
        throw new Error("auth-service: watcher allocation UID collision across actor lifecycles - refusing to share a connection-owned pair");
      // Reconciliation is needed only when the actor reaches its ceiling. Below the ceiling an
      // allocation remains conservatively occupied until pressure exists, keeping the ordinary
      // connect path at one ensure instead of O(retained pairs) exact broker probes.
      if (!sameUid && rows.length >= AGENT_KV_WATCH_ALLOCATION_LIMIT) {
        for (const existing of rows)
          if (await broker.pairGone(existing.row.watchUid)) rmSync(existing.path);
        rows = listActorAllocations(this.dir, allocation.owner, allocation.actor);
        sameUid = rows.find(({ row }) => row.watchUid === allocation.watchUid);
      }
      if (!sameUid) {
        if (rows.length >= AGENT_KV_WATCH_ALLOCATION_LIMIT)
          throw new Error(
            `auth-service: watcher allocation capacity reached for ${allocation.owner}.${allocation.actor} ` +
            `(${AGENT_KV_WATCH_ALLOCATION_LIMIT} retained connection pairs); close abandoned clients or wait for their 5m inactivity cleanup`,
          );
        // Reserve first. A crash after this write consumes capacity conservatively; the next
        // admission removes it only if both exact consumers are absent.
        writeAllocation(this.dir, allocation);
      }
      try {
        await broker.ensurePair();
      } catch (err) {
        // A clean no-create failure need not strand a slot. If the broker cannot prove absence, keep
        // the row: under-counting a partially created pair would reopen the amplification boundary.
        try {
          if (await broker.pairGone(allocation.watchUid))
            rmSync(join(allocationDir(this.dir), allocationFilename(allocation)), { force: true });
        } catch { /* keep the conservative reservation and surface the original ensure failure */ }
        throw err;
      }
      prepared = true;
    } finally {
      // A cleanup failure after successful provisioning denies the connect (fail closed and names
      // the leaked authority client). While another error is already denying it, preserve that
      // primary diagnosis; the no-reconnect authority client has no further usable work.
      if (prepared) await broker.close();
      else await broker.close().catch(() => {});
    }
  }
}
