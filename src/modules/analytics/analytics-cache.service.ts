import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { cacheConnectionOptions } from '../../queue/redis.config';
import { cacheKeyPrefix } from '../../queue/queue.constants';
import { MetricsService } from '../../metrics/metrics.service';

/** Cache namespaces — each has its own per-tenant version counter. */
export const CACHE_NS = {
  DASHBOARD: 'dashboard',
  DAILY: 'daily',
} as const;

export type CacheNamespace = (typeof CACHE_NS)[keyof typeof CACHE_NS];

/**
 * Redis read-through cache for expensive analytics reads, with strict
 * per-tenant isolation and stale-free invalidation.
 *
 * ── Key design ──────────────────────────────────────────────────────────────
 * Every key is namespaced by tenant AND by a per-(tenant, namespace) version
 * counter:
 *
 *   value:   analytics:tenant:{tenantId}:{ns}:v{ver}:{suffix}
 *   version: analytics:tenant:{tenantId}:{ns}:ver
 *
 * Invalidation is an `INCR` of the version counter, which atomically orphans
 * every old value key (they expire on their own TTL and are never read again).
 * This makes invalidation O(1) — no `KEYS`/`SCAN` scan, no risk of deleting
 * another tenant's keys, and no stale-serve window: a writer racing a reader can
 * only ever write under an already-orphaned version.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * • Tenant isolation: the tenant id is baked into every key, so one tenant can
 *   never read another's cached payload (no cache leakage / poisoning).
 * • Fail-open: Redis is OPTIONAL (REDIS_URL may be unset, e.g. API-only boots).
 *   When unconfigured or on any Redis error, the cache degrades to a no-op and
 *   the caller falls through to the database — correctness never depends on the
 *   cache being up.
 * • Single-flight on miss (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M4):
 *   on a cache miss, `wrap()` first tries to acquire a short-lived compute
 *   LEASE (`SET leaseKey token NX PX`) before calling `producer()`. Only the
 *   caller that wins the lease actually runs the (expensive) aggregation;
 *   every other concurrent caller for the SAME key polls briefly for the
 *   winner's result instead of recomputing it too. If the poll window expires
 *   with no result (the winner crashed, or is unusually slow), a loser falls
 *   through to calling `producer()` itself — a safe, no-worse-than-before
 *   last resort, never a correctness issue (the version-counter design means
 *   a slow/duplicate compute can only ever write under the CURRENT version).
 */
/**
 * Version-key TTL (M17 — docs/CACHING_QUEUES_AUDIT.md): the version counter
 * itself previously had NO expiry, so if it were ever evicted while a `v{n}`
 * value key survived, `version()` would read back '0' and a stale surviving
 * `v0` key could become readable again. In this codebase's actual production
 * config that specific path is already closed by `noeviction` + a real
 * `maxmemory` ceiling (enforced at boot — see C1/§0.8.9/§0.11.4): nothing
 * gets evicted for memory pressure once those are in place, so a version key
 * cannot silently disappear while a value key survives. This TTL is
 * defense-in-depth on top of that (a misconfigured/overridden environment,
 * or a future manual `DEL`) — set far longer than any value key's own TTL
 * (`ttlSec`, typically 60s) so it can never expire out from under an
 * actively-used namespace: by the time 30 days of zero writes has passed,
 * every value key from that period is long gone on its own 60s TTL, so
 * there is no window where an old orphaned value key could be resurrected.
 */
const VERSION_KEY_TTL_SECONDS = 30 * 24 * 3600;

/** Compute-lease TTL (M4) — generous relative to a real aggregation query, but
 *  bounded so a crashed winner's lease self-expires instead of blocking
 *  every subsequent request until the key's own value TTL rolls over. */
const LEASE_TTL_MS = 5_000;
/** How often a loser polls for the winner's result while the lease is held. */
const LEASE_POLL_INTERVAL_MS = 100;
/** Total time a loser waits before giving up and computing it itself. */
const LEASE_POLL_MAX_WAIT_MS = 4_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class AnalyticsCacheService implements OnModuleDestroy {
  private readonly logger = new Logger('AnalyticsCacheService');
  private readonly client: Redis | null;
  private readonly ttlSec: number;

  constructor(
    private readonly config: ConfigService,
    // Optional (unit tests construct this service directly with only a
    // config); `MetricsModule` is global, so Nest's real DI container always
    // supplies a real instance in the running app.
    private readonly metrics?: MetricsService,
  ) {
    this.ttlSec = Number(this.config.get('ANALYTICS_CACHE_TTL', 60)) || 60;

    const enabled =
      this.config.get<string>('ANALYTICS_CACHE_ENABLED', 'true') !== 'false';
    const url = this.config.get<string>('REDIS_URL');

    if (!enabled || !url || url.trim().length === 0) {
      this.client = null;
      this.logger.log(
        'Analytics cache DISABLED (no REDIS_URL or explicitly off) — reads fall through to DB.',
      );
      return;
    }

    // A DEDICATED connection on the CACHE profile (fail-fast: commandTimeout,
    // no offline queue) — never the BullMQ blocking/producer connection. Cache
    // traffic must never contend with the queue's blocking commands, and a
    // cache read/write must reject fast rather than buffer.
    this.client = new Redis({
      ...cacheConnectionOptions(this.config),
      lazyConnect: true,
    });
    this.client.on('error', (err) =>
      this.logger.warn(
        `Redis cache error (failing open to DB): ${err.message}`,
      ),
    );
    this.client
      .connect()
      .catch((err) =>
        this.logger.warn(
          `Redis cache connect failed (failing open to DB): ${err.message}`,
        ),
      );
  }

  /**
   * Read-through helper: return the cached value for (tenant, ns, suffix) or
   * compute it via `producer`, cache it, and return it. Always tenant-scoped.
   */
  async wrap<T>(
    tenantId: string,
    ns: CacheNamespace,
    suffix: string,
    producer: () => Promise<T>,
  ): Promise<T> {
    if (!this.client) return producer();

    const ver = await this.version(tenantId, ns);
    const key = this.valueKey(tenantId, ns, ver, suffix);

    try {
      const hit = await this.client.get(key);
      if (hit !== null) {
        this.metrics?.recordCacheOperation('analytics', 'hit');
        return JSON.parse(hit) as T;
      }
    } catch (err) {
      this.warnOnce('read', err);
    }
    this.metrics?.recordCacheOperation('analytics', 'miss');

    // Single-flight (M4): try to become the one caller that actually computes
    // this key. A lease acquire failure (Redis error) is treated the same as
    // "didn't win" — fall through to computing directly, never block on it.
    const leaseKey = `${key}:lease`;
    const token = randomUUID();
    let wonLease = false;
    try {
      wonLease =
        (await this.client.set(leaseKey, token, 'PX', LEASE_TTL_MS, 'NX')) ===
        'OK';
    } catch (err) {
      this.warnOnce('lease-acquire', err);
    }

    if (!wonLease) {
      const winnerValue = await this.pollForValue<T>(key);
      if (winnerValue !== undefined) return winnerValue;
      // Poll window expired with no result — fall through and compute it
      // ourselves rather than waiting indefinitely.
    }

    try {
      const value = await producer();
      try {
        await this.client.set(key, JSON.stringify(value), 'EX', this.ttlSec);
      } catch (err) {
        this.warnOnce('write', err);
      }
      return value;
    } finally {
      if (wonLease) {
        // Best-effort release so the NEXT expiry-driven miss doesn't wait out
        // a lease we no longer hold — a failure here just means losers wait
        // for LEASE_TTL_MS's natural expiry instead, not a correctness issue.
        await this.client
          .eval(AnalyticsCacheService.RELEASE_LEASE_SCRIPT, 1, leaseKey, token)
          .catch((err) => this.warnOnce('lease-release', err));
      }
    }
  }

  /** Compare-and-delete — never releases a lease this caller doesn't still hold. */
  private static readonly RELEASE_LEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  /** Polls the value key while another caller holds the compute lease. `undefined` = gave up. */
  private async pollForValue<T>(key: string): Promise<T | undefined> {
    const deadline = Date.now() + LEASE_POLL_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(LEASE_POLL_INTERVAL_MS);
      try {
        const hit = await this.client!.get(key);
        if (hit !== null) return JSON.parse(hit) as T;
      } catch (err) {
        this.warnOnce('lease-poll', err);
        return undefined;
      }
    }
    return undefined;
  }

  /** Invalidate an entire (tenant, namespace) — O(1) version bump. */
  async invalidate(tenantId: string, ns: CacheNamespace): Promise<void> {
    if (!this.client) return;
    try {
      const key = this.versionKey(tenantId, ns);
      await this.client.incr(key);
      // Defense-in-depth TTL (M17) — see VERSION_KEY_TTL_SECONDS docstring.
      // A failure here is non-fatal: the INCR above already succeeded, so
      // invalidation itself is not lost, only this pass's TTL refresh.
      await this.client.expire(key, VERSION_KEY_TTL_SECONDS);
    } catch (err) {
      this.warnOnce('invalidate', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async version(tenantId: string, ns: CacheNamespace): Promise<string> {
    if (!this.client) return '0';
    try {
      return (await this.client.get(this.versionKey(tenantId, ns))) ?? '0';
    } catch (err) {
      this.warnOnce('version', err);
      return '0';
    }
  }

  private versionKey(tenantId: string, ns: CacheNamespace): string {
    return `${cacheKeyPrefix()}analytics:tenant:${tenantId}:${ns}:ver`;
  }

  private valueKey(
    tenantId: string,
    ns: CacheNamespace,
    ver: string,
    suffix: string,
  ): string {
    return `${cacheKeyPrefix()}analytics:tenant:${tenantId}:${ns}:v${ver}:${suffix}`;
  }

  private warnOnce(op: string, err: unknown): void {
    this.logger.warn(
      `cache ${op} failed (failing open): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
