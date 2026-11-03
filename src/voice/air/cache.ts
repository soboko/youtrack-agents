/**
 * A small in-memory cache with a time to live and a size cap (YA-36). It lives as long as the Lambda execution
 * environment, so repeated questions within a few minutes cost no PurpleAir points. Oldest entries are dropped first
 * once the cap is reached. The clock is injected.
 */

export interface TtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now: () => number;
}

interface Entry<V> {
  value: V;
  storedAt: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly options: TtlCacheOptions;

  constructor(options: TtlCacheOptions) {
    if (!(options.ttlMs > 0) || !(options.maxEntries > 0)) throw new Error('TtlCache needs a positive ttl and size');
    this.options = options;
  }

  /** The value stored under `key`, if it is younger than the ttl. A clock that moved backwards expires it too. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const age = this.options.now() - entry.storedAt;
    if (age < 0 || age >= this.options.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, {value, storedAt: this.options.now()});
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
