import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

import { MetricsService } from '../metrics/metrics.service';

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
  private readonly fallback = new ThrottlerStorageService();

  constructor(
    private readonly primary: ThrottlerStorage,
    private readonly metrics: MetricsService,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ReturnType<ThrottlerStorage['increment']> {
    try {
      return await this.primary.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      this.logger.warn(
        `Throttler Redis storage unavailable — degrading to local in-memory limiting for this request: ${(err as Error)?.message ?? String(err)}`,
      );
      this.metrics.recordThrottlerStorageEvent('redis_unavailable');
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
