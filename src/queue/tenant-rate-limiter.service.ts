import { Injectable, Logger } from '@nestjs/common';

import { AppRedisService } from './app-redis.service';
import { cacheKeyPrefix } from './queue.constants';

/**
 * `rlConsume` (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M16): registered
 * via `client.defineCommand` in the constructor below so ioredis ships the
 * script body once via `EVALSHA`/caches its SHA, instead of re-sending the
 * full ~1.5KB Lua text on `EVAL` for every single rate-limit check (this
 * script runs on every campaign-recipient send, at real volume). ioredis
 * falls back to a plain `EVAL` automatically on a `NOSCRIPT` reply (e.g.
 * after a `SCRIPT FLUSH` or a Redis restart), so this is purely a bandwidth/
 * CPU optimization — no behavior change.
 */
declare module 'ioredis' {
  interface Redis {
    rlConsume(
      bucketKey: string,
      dailyKey: string,
      monthlyKey: string,
      capacity: string,
      refillPerSec: string,
      now: string,
      dailyCap: string,
      monthlyCap: string,
      dailyTtl: string,
      monthlyTtl: string,
    ): Promise<[number, number]>;
  }
}

export interface RateLimitPolicy {
  /** Per-minute throttle (token-bucket capacity & refill basis). */
  ratePerMinute: number;
  /** Optional hard daily cap (sends/day). -1/undefined = unlimited. */
  dailyCap?: number | null;
  /** Optional hard monthly cap (sends/month). -1/undefined = unlimited. */
  monthlyCap?: number | null;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'RATE'; retryAfterMs: number }
  | { allowed: false; reason: 'DAILY_CAP' | 'MONTHLY_CAP' };

/**
 * Per-tenant rate limiting backed by a single atomic Redis Lua script.
 *
 * One round-trip both (a) enforces a token bucket for `ratePerMinute` and
 * (b) increments+checks the daily/monthly caps — so caps and rate can never
 * drift under concurrency across many worker pods. A `RATE` denial is transient
 * (retry after the returned delay); a `*_CAP` denial is terminal for the period
 * (the recipient is SKIPPED, not retried).
 *
 * Runs on `AppRedisService.rateLimiter` — a dedicated, fail-fast connection
 * (`commandTimeout`, no offline queue), NOT the BullMQ producer connection.
 * Before Phase 0 this piggybacked on `QueueService.client()` (the producer
 * profile), so every caller's "Redis unavailable → fail open/closed" branch
 * (e.g. ApiKeyAuthGuard, the OAuth refresh lock) never actually ran during an
 * outage — the call just hung for the producer's buffered-retry window
 * instead. See docs/CACHING_QUEUES_AUDIT.md §0.2/§0.5 (C2).
 */
@Injectable()
export class TenantRateLimiterService {
  private readonly logger = new Logger('TenantRateLimiter');

  // KEYS: [bucket, dailyCounter, monthlyCounter]
  // ARGV: [capacity, refillPerSec, nowMs, dailyCap, monthlyCap, dailyTtl, monthlyTtl]
  private static readonly SCRIPT = `
    local capacity = tonumber(ARGV[1])
    local refill = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local dailyCap = tonumber(ARGV[4])
    local monthlyCap = tonumber(ARGV[5])
    local dailyTtl = tonumber(ARGV[6])
    local monthlyTtl = tonumber(ARGV[7])

    if dailyCap >= 0 then
      local d = tonumber(redis.call('GET', KEYS[2]) or '0')
      if d >= dailyCap then return {2, 0} end
    end
    if monthlyCap >= 0 then
      local m = tonumber(redis.call('GET', KEYS[3]) or '0')
      if m >= monthlyCap then return {3, 0} end
    end

    local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
    local tokens = tonumber(state[1])
    local ts = tonumber(state[2])
    if tokens == nil then tokens = capacity; ts = now end

    local elapsed = math.max(0, now - ts) / 1000.0
    tokens = math.min(capacity, tokens + elapsed * refill)

    if tokens < 1 then
      local needed = (1 - tokens) / refill
      local retryMs = math.ceil(needed * 1000)
      redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
      redis.call('PEXPIRE', KEYS[1], 120000)
      return {1, retryMs}
    end

    tokens = tokens - 1
    redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
    redis.call('PEXPIRE', KEYS[1], 120000)

    if dailyCap >= 0 then
      local nd = redis.call('INCR', KEYS[2])
      if nd == 1 then redis.call('EXPIRE', KEYS[2], dailyTtl) end
    end
    if monthlyCap >= 0 then
      local nm = redis.call('INCR', KEYS[3])
      if nm == 1 then redis.call('EXPIRE', KEYS[3], monthlyTtl) end
    end
    return {0, 0}
  `;

  constructor(private readonly appRedis: AppRedisService) {
    this.appRedis.rateLimiter.defineCommand('rlConsume', {
      numberOfKeys: 3,
      lua: TenantRateLimiterService.SCRIPT,
    });
  }

  async consume(
    tenantId: string,
    campaignId: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitDecision> {
    const client = this.appRedis.rateLimiter;

    const capacity = Math.max(1, policy.ratePerMinute);
    const refillPerSec = capacity / 60;
    const now = Date.now();
    const { dayKey, monthKey } = this.periodKeys(tenantId);

    // Per-campaign bucket so one campaign can't starve another in the tenant.
    // Env-prefixed (M3 — docs/CACHING_QUEUES_AUDIT.md) so a mis-pointed
    // REDIS_URL can't let one environment's rate limiter see another's.
    const prefix = cacheKeyPrefix();
    const bucketKey = `${prefix}rl:bucket:${tenantId}:${campaignId}`;
    const dailyKey = `${prefix}rl:day:${tenantId}:${dayKey}`;
    const monthlyKey = `${prefix}rl:month:${tenantId}:${monthKey}`;

    const res = await client.rlConsume(
      bucketKey,
      dailyKey,
      monthlyKey,
      String(capacity),
      String(refillPerSec),
      String(now),
      String(policy.dailyCap ?? -1),
      String(policy.monthlyCap ?? -1),
      String(this.secondsUntilEndOfDay()),
      String(this.secondsUntilEndOfMonth()),
    );

    const [status, retryMs] = res;
    switch (status) {
      case 0:
        return { allowed: true };
      case 1:
        return {
          allowed: false,
          reason: 'RATE',
          retryAfterMs: Math.max(250, retryMs),
        };
      case 2:
        return { allowed: false, reason: 'DAILY_CAP' };
      default:
        return { allowed: false, reason: 'MONTHLY_CAP' };
    }
  }

  /**
   * Daily/monthly caps roll over at UTC midnight, not the tenant's local
   * midnight (L9 — docs/CACHING_QUEUES_AUDIT.md). For a Saudi Arabia tenant
   * (UTC+3) that's 03:00 local, not 00:00 local — same as every cron-based
   * sweep in this codebase (`@Cron` expressions run in the process's system
   * timezone, which deployments run as UTC). Documented as almost certainly
   * the intended behavior (a single, consistent, DST-free rollover instant
   * for every tenant regardless of timezone, rather than N different
   * rollover instants to track) rather than a bug — left unchanged; this
   * comment exists so the mismatch is a documented decision, not a silent
   * one, the next time someone traces why a cap resets mid-morning locally.
   */
  private periodKeys(_tenantId: string): { dayKey: string; monthKey: string } {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return { dayKey: `${y}${m}${day}`, monthKey: `${y}${m}` };
  }

  private secondsUntilEndOfDay(): number {
    const now = new Date();
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000));
  }

  private secondsUntilEndOfMonth(): number {
    const now = new Date();
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return Math.max(60, Math.ceil((end.getTime() - now.getTime()) / 1000));
  }
}
