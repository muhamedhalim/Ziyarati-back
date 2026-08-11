import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

import { MetricsService } from '../metrics/metrics.service';
import { BoundedLocalCounter } from './bounded-local-counter';
import { DegradedModeLogLimiter } from './degraded-mode-log-limiter';

/**
 * `ThrottlerStorage`-conforming adapter over {@link BoundedLocalCounter}
 * (009-auth-abuse-resistance, ZT-002) — replaces `@nestjs/throttler`'s own
 * `ThrottlerStorageService` (`_storage = new Map()` with no delete path,
 * one `setTimeout` per hit — the actual defect this finding names).
 * Constructed lazily on the first call, sized from that call's own `ttl`
 * (this app defines exactly one throttler, `default`, `ttl: 60_000`), so
 * memory is fixed the moment a Redis outage begins and never grows with
 * request volume or key cardinality.
 */
class BoundedThrottlerFallback {
  private counter: BoundedLocalCounter | null = null;

  constructor(private readonly width: number) {}

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ReturnType<ThrottlerStorage['increment']> {
    if (!this.counter) {
      this.counter = new BoundedLocalCounter({ width: this.width, depth: 3, windowMs: ttl });
    }
    const count = this.counter.increment(`${throttlerName}:${key}`);
    const isBlocked = count > limit;
    return Promise.resolve({
      totalHits: count,
      timeToExpire: Math.max(0, Math.ceil(ttl / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.max(0, Math.ceil(blockDuration / 1000)) : 0,
    });
  }
}

/**
 * `PERF-CACHE-001` fix. `ThrottlerGuard` is the first of 6 global `APP_GUARD`s
 * (`app.module.ts`) and runs on every route, including `@Public()` ones. Its
 * Redis-backed storage (`ThrottlerStorageRedisService`) throws a raw,
 * unhandled `ioredis` error the instant Redis is unreachable — confirmed by a
 * real outage test (`reports/cache-fail-open-closed.md`, T080) to 500 100% of
 * requests platform-wide, including login, in under 15ms, with no app-level
 * try/catch anywhere in `@nestjs/throttler`'s guard or the storage adapter.
 *
 * Every OTHER Redis-backed policy already in this codebase fails open by
 * deliberate, documented design on a Redis error — `LoginProtectionService`
 * (FR-020, explicit rationale: failing closed here would convert a Redis
 * outage into a total authentication outage), `TenantRateLimiterService` via
 * `ApiKeyAuthGuard`, and `AnalyticsCacheService`. A fail-closed `ThrottlerGuard`
 * would be the one inconsistent, newly-introduced platform-wide single point
 * of failure. But unconditionally allowing every request during an outage
 * ("blindly disabling rate limiting") is not the safest available option
 * either — this wraps the Redis storage with a same-process, in-memory
 * fallback (`ThrottlerStorageService`, NestJS's own built-in default, and the
 * exact behavior this app ran before its Redis migration — see
 * `app.module.ts`'s own comment on why it moved to Redis) so a Redis outage
 * degrades rate limiting to per-process enforcement instead of removing it.
 *
 * Every call tries the primary (Redis) storage first — there is no sticky
 * "circuit open" state — so the very next request after Redis recovers is
 * served by Redis again automatically, matching T080's confirmed self-recovery
 * behavior with zero app restart.
 */
export class FailsafeThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(FailsafeThrottlerStorage.name);
  private readonly degradedLog = new DegradedModeLogLimiter(this.logger, 'Throttler Redis storage');
  private readonly fallback: BoundedThrottlerFallback;

  /**
   * `fallbackWidth` is an OPTIONAL third parameter, not a required one —
   * this class is constructed manually (not through Nest DI) both here in
   * production (`app.module.ts`) and directly in its own unit spec with
   * exactly `(primary, metrics)`, so adding a required config dependency
   * would break every existing call site. Defaults to the same value as
   * `AUTH_ABUSE_FALLBACK_WIDTH`'s Joi default; production wiring passes the
   * configured value explicitly.
   */
  constructor(
    private readonly primary: ThrottlerStorage,
    private readonly metrics: MetricsService,
    fallbackWidth: number = 4096,
  ) {
    this.fallback = new BoundedThrottlerFallback(fallbackWidth);
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ReturnType<ThrottlerStorage['increment']> {
    try {
      const result = await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
      this.degradedLog.recordSuccess();
      return result;
    } catch (err) {
      this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
      // Unchanged: exactly one call per failing increment(), regardless of
      // how DegradedModeLogLimiter rate-limits the LOG line above — this is
      // the metric-cardinality contract failsafe-throttler-storage.spec.ts
      // pins exactly (5 failures -> 5 calls; 1 failure + 1 success -> 1 call).
      this.metrics.recordThrottlerStorageEvent('redis_unavailable');
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
