import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppRedisService } from './app-redis.service';
import { cacheKeyPrefix } from './queue.constants';
import { BoundedLocalCounter } from './bounded-local-counter';
import { DegradedModeLogLimiter } from './degraded-mode-log-limiter';
import { MetricsService } from '../metrics/metrics.service';
import {
  AUTH_ABUSE_KEY_NAMESPACE,
  AuthAbuseLimiterScope,
} from '../modules/auth/auth-abuse.constants';

declare module 'ioredis' {
  interface Redis {
    fixedWindowIncr(key: string, ttlSeconds: string): Promise<number>;
  }
}

export interface FixedWindowDecision {
  /** Whether this request is admitted. */
  allowed: boolean;
  /** Whether the decision was made by the local fallback (Redis was unavailable) rather than Redis. */
  degraded: boolean;
  /** The count this decision was based on — for internal use/testing, never returned to a caller of the public API. */
  count: number;
}

/**
 * Shared fixed-window rate-limiter façade (ZT-002, ZT-006) — Redis-backed
 * when the store is healthy, falling back to the bounded local primitive
 * when it is not. Serves `forgot-password`, `reset-password` (both layers)
 * and `register-owner` (both layers); `login` is deliberately NOT routed
 * through this service (see `LoginProtectionService`'s own docstring) —
 * `login-protection.service.spec.ts` mocks `AppRedisService.rateLimiter`
 * directly and constructs the service with exactly its existing three
 * constructor arguments, so introducing this service as a fourth dependency
 * there would break that frozen regression oracle (tasks.md T046) rather
 * than change login's behaviour. `login` still shares this service's
 * `BoundedLocalCounter` PRIMITIVE (constructed independently) and its
 * `auth_abuse_limiter_events_total` metric label, just not this
 * orchestration class.
 *
 * Redis path: the same atomic `INCR`-then-`EXPIRE`-only-on-create Lua shape
 * `LoginProtectionService.RECORD_FAILURE_SCRIPT` already uses (research.md
 * §R2) — a separate `INCR` + `EXPIRE` could crash between the two and leave
 * a TTL-less (permanently locked) key. Registered once via `defineCommand`
 * under a distinct command name so it does not collide with the
 * already-registered `loginFailRecord` on the same client.
 *
 * Every decision tries Redis first — there is no sticky circuit state, so
 * the very next call after Redis recovers is served by Redis again (FR-032).
 */
@Injectable()
export class FixedWindowLimiterService {
  private readonly logger = new Logger(FixedWindowLimiterService.name);
  private readonly degradedLog = new DegradedModeLogLimiter(
    this.logger,
    'FixedWindowLimiterService',
  );

  private static readonly INCR_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  /** One bounded local counter per scope, constructed lazily on first use — bounded by the closed scope enum (never attacker-controlled), not by request volume. */
  private readonly fallbacks = new Map<AuthAbuseLimiterScope, BoundedLocalCounter>();

  constructor(
    private readonly appRedis: AppRedisService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.appRedis.rateLimiter.defineCommand('fixedWindowIncr', {
      numberOfKeys: 1,
      lua: FixedWindowLimiterService.INCR_SCRIPT,
    });
  }

  /**
   * Increments the counter for `scope`/`subject` and returns whether it is
   * within `limit` for a `windowSeconds`-wide window. `subject` MUST already
   * be a cryptographic digest (or the literal endpoint-wide subject) — this
   * service never sees a raw email, phone or token (FR-013b).
   */
  async consume(
    scope: AuthAbuseLimiterScope,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<FixedWindowDecision> {
    const windowIndex = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = this.buildKey(scope, subject, windowIndex);
    try {
      const count = await this.appRedis.rateLimiter.fixedWindowIncr(
        key,
        String(windowSeconds),
      );
      this.degradedLog.recordSuccess();
      const allowed = count <= limit;
      this.metrics.recordAuthAbuseLimiterEvent(scope, allowed ? 'allowed' : 'refused');
      return { allowed, degraded: false, count };
    } catch (err) {
      return this.consumeDegraded(scope, subject, limit, windowSeconds, err, true);
    }
  }

  /**
   * Read-only equivalent of {@link consume} — does not increment. Used by
   * reset-password's failure-ceiling layer, which must be checked BEFORE
   * the token lookup without counting the check itself (FR-064: the ceiling
   * counts invalid-token attempts only, not every read of it).
   */
  async peek(
    scope: AuthAbuseLimiterScope,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<FixedWindowDecision> {
    const windowIndex = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = this.buildKey(scope, subject, windowIndex);
    try {
      const raw = await this.appRedis.rateLimiter.get(key);
      const count = raw ? Number(raw) : 0;
      this.degradedLog.recordSuccess();
      return { allowed: count < limit, degraded: false, count };
    } catch (err) {
      return this.consumeDegraded(scope, subject, limit, windowSeconds, err, false);
    }
  }

  private async consumeDegraded(
    scope: AuthAbuseLimiterScope,
    subject: string,
    limit: number,
    windowSeconds: number,
    err: unknown,
    write: boolean,
  ): Promise<FixedWindowDecision> {
    this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
    const degradedFactor = this.config.get<number>('AUTH_ABUSE_DEGRADED_FACTOR', 0.5);
    const degradedLimit = Math.max(1, Math.ceil(limit * degradedFactor));
    const counter = this.fallbackFor(scope, windowSeconds);
    const localKey = `${scope}:${subject}`;
    // Mirrors the healthy-mode peek()/consume() pairing exactly (see their
    // own comparisons above): `write=false` (peek) reads the CURRENT,
    // not-yet-incremented count, so admission needs strict `<` — "is there
    // room for at least one more" — while `write=true` (consume) reads the
    // POST-increment count, so `<=` is correct — "does this one fit". Using
    // `<=` for both let exactly one extra request through on every peek-then
    // -consume pair once degradedLimit was reached (caught by
    // auth-abuse-reset-password.e2e-spec.ts's T094: a
    // DEGRADED_INVALID_CEILING+3 flood returned DEGRADED_INVALID_CEILING+1
    // "admitted" responses instead of exactly DEGRADED_INVALID_CEILING).
    const count = write ? counter.increment(localKey) : counter.peek(localKey);
    const allowed = write ? count <= degradedLimit : count < degradedLimit;
    this.metrics.recordAuthAbuseLimiterEvent(
      scope,
      allowed ? 'degraded_allowed' : 'degraded_refused',
    );
    return { allowed, degraded: true, count };
  }

  private fallbackFor(scope: AuthAbuseLimiterScope, windowSeconds: number): BoundedLocalCounter {
    let counter = this.fallbacks.get(scope);
    if (!counter) {
      const width = this.config.get<number>('AUTH_ABUSE_FALLBACK_WIDTH', 4096);
      counter = new BoundedLocalCounter({ width, depth: 3, windowMs: windowSeconds * 1000 });
      this.fallbacks.set(scope, counter);
    }
    return counter;
  }

  private buildKey(scope: AuthAbuseLimiterScope, subject: string, windowIndex: number): string {
    return `${cacheKeyPrefix()}${AUTH_ABUSE_KEY_NAMESPACE}${scope}:${windowIndex}:${subject}`;
  }
}
