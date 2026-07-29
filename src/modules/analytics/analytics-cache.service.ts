import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { cacheConnectionOptions } from '../../queue/redis.config';

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
 */
@Injectable()
export class AnalyticsCacheService implements OnModuleDestroy {
  private readonly logger = new Logger('AnalyticsCacheService');
  private readonly client: Redis | null;
  private readonly ttlSec: number;

  constructor(private readonly config: ConfigService) {
    this.ttlSec = Number(this.config.get('ANALYTICS_CACHE_TTL', 60)) || 60;

    const enabled = this.config.get<string>('ANALYTICS_CACHE_ENABLED', 'true') !== 'false';
    const url = this.config.get<string>('REDIS_URL');

    if (!enabled || !url || url.trim().length === 0) {
      this.client = null;
      this.logger.log('Analytics cache DISABLED (no REDIS_URL or explicitly off) — reads fall through to DB.');
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
      this.logger.warn(`Redis cache error (failing open to DB): ${err.message}`),
    );
    this.client.connect().catch((err) =>
      this.logger.warn(`Redis cache connect failed (failing open to DB): ${err.message}`),
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
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (err) {
      this.warnOnce('read', err);
    }

    const value = await producer();

    try {
      await this.client.set(key, JSON.stringify(value), 'EX', this.ttlSec);
    } catch (err) {
      this.warnOnce('write', err);
    }
    return value;
  }

  /** Invalidate an entire (tenant, namespace) — O(1) version bump. */
  async invalidate(tenantId: string, ns: CacheNamespace): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.incr(this.versionKey(tenantId, ns));
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
    return `analytics:tenant:${tenantId}:${ns}:ver`;
  }

  private valueKey(tenantId: string, ns: CacheNamespace, ver: string, suffix: string): string {
    return `analytics:tenant:${tenantId}:${ns}:v${ver}:${suffix}`;
  }

  private warnOnce(op: string, err: unknown): void {
    this.logger.warn(`cache ${op} failed (failing open): ${err instanceof Error ? err.message : String(err)}`);
  }
}
