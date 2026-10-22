/**
 * RL-08 — enqueue backpressure on Redis memory.
 *
 * Rate limits, the cache and BullMQ share one `noeviction` Redis. At 100 %
 * every write fails at once: limiters drop to per-task counters and every
 * enqueue errors. Producers that can wait (the outbox relay, on-demand
 * exports) ask this probe first and hold back above a threshold, so queued
 * work stays in Postgres and the last headroom is left for the small,
 * short-lived rate-limit keys.
 */

/** `INFO memory` reply → used and configured max bytes. `null` when unbounded or unparseable. */
export function parseRedisMemory(
  info: string,
): { used: number; max: number } | null {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:(\\d+)\\s*$`, 'm').exec(info);
    return match ? Number(match[1]) : undefined;
  };
  const used = field('used_memory');
  const max = field('maxmemory');
  if (used === undefined || !max) return null;
  return { used, max };
}

export interface RedisHeadroomOptions {
  /** Reads `INFO memory`. Should be a fail-fast connection. */
  info: () => Promise<string>;
  /** Refuse at or above this share of `maxmemory`, 1–100. */
  maxPercent: number;
  /** How long one reading is reused, so a burst costs one INFO call. */
  cacheMs?: number;
  now?: () => number;
}

export class RedisHeadroomProbe {
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cached?: { at: number; ok: boolean };
  private inflight?: Promise<boolean>;

  constructor(private readonly options: RedisHeadroomOptions) {
    this.cacheMs = options.cacheMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * `true` when there is room to enqueue. Fails OPEN on an INFO error or an
   * unbounded Redis: the enqueue itself then succeeds or fails on its own, and
   * this check must never become a new way to stop work.
   */
  async hasHeadroom(): Promise<boolean> {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) {
      return this.cached.ok;
    }
    this.inflight ??= this.read().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async read(): Promise<boolean> {
    let ok = true;
    try {
      const memory = parseRedisMemory(await this.options.info());
      if (memory)
        ok = (memory.used / memory.max) * 100 < this.options.maxPercent;
    } catch {
      ok = true;
    }
    this.cached = { at: this.now(), ok };
    return ok;
  }
}
