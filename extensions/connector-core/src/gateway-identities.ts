/**
 * Session-local identity bookkeeping for MCP hosts.  It intentionally knows
 * nothing about credentials, workspace targets, or transports: a host supplies
 * creation and cleanup while this class makes key opens idempotent and cleanup
 * exact.
 */
export interface GatewayIdentity<T> {
  readonly handle: string;
  readonly key: string;
  readonly value: T;
  close(): Promise<void>;
}

export class GatewayIdentityRegistry<T> {
  #byHandle = new Map<string, GatewayIdentity<T>>();
  #byKey = new Map<string, GatewayIdentity<T>>();
  #opening = new Map<string, Promise<GatewayIdentity<T>>>();
  #defaultHandle: string | undefined;

  async open(key: string, create: () => Promise<GatewayIdentity<T>>): Promise<{ identity: GatewayIdentity<T>; created: boolean }> {
    const present = this.#byKey.get(key);
    if (present) return { identity: present, created: false };
    const pending = this.#opening.get(key);
    if (pending) return { identity: await pending, created: false };
    const opening = create();
    this.#opening.set(key, opening);
    try {
      const identity = await opening;
      if (!identity.handle || identity.key !== key) throw new Error("gateway identity factory returned an invalid identity");
      if (this.#byHandle.has(identity.handle)) throw new Error(`gateway identity handle collision: ${identity.handle}`);
      this.#byHandle.set(identity.handle, identity);
      this.#byKey.set(key, identity);
      return { identity, created: true };
    } finally {
      this.#opening.delete(key);
    }
  }

  list(): readonly GatewayIdentity<T>[] { return [...this.#byHandle.values()]; }

  select(handle?: string): GatewayIdentity<T> {
    if (handle) {
      const identity = this.#byHandle.get(handle);
      if (!identity) throw new Error(`IDENTITY_NOT_FOUND: no open identity matches handle ${handle}; call cotal_identity_list`);
      return identity;
    }
    if (this.#defaultHandle) {
      const identity = this.#byHandle.get(this.#defaultHandle);
      if (identity) return identity;
    }
    if (this.#byHandle.size === 1) return this.#byHandle.values().next().value!;
    if (this.#byHandle.size === 0) throw new Error("IDENTITY_REQUIRED: no identity is open; call cotal_identity_open");
    throw new Error("IDENTITY_REQUIRED: more than one identity is open; call cotal_identity_use or supply identity");
  }

  use(handle: string): GatewayIdentity<T> {
    const identity = this.select(handle);
    this.#defaultHandle = identity.handle;
    return identity;
  }

  async close(handle: string): Promise<GatewayIdentity<T>> {
    const identity = this.select(handle);
    await identity.close();
    this.#byHandle.delete(identity.handle);
    this.#byKey.delete(identity.key);
    if (this.#defaultHandle === identity.handle) this.#defaultHandle = undefined;
    return identity;
  }

  async closeAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const identity of [...this.#byHandle.values()]) {
      try { await this.close(identity.handle); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "gateway identity cleanup failed");
  }
}
