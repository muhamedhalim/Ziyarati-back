import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

import { AppRedisService } from '../../queue/app-redis.service';
import { cacheKeyPrefix } from '../../queue/queue.constants';
import { BoundedLocalCounter } from '../../queue/bounded-local-counter';
import { DegradedModeLogLimiter } from '../../queue/degraded-mode-log-limiter';
import { MetricsService } from '../../metrics/metrics.service';

/**
 * `loginFailRecord` (FND-008): registered via `client.defineCommand` in the
 * constructor so ioredis ships the script once and reuses it by `EVALSHA`
 * (falling back to `EVAL` on `NOSCRIPT`) — the same pattern
 * `TenantRateLimiterService` established.
 */
declare module 'ioredis' {
  interface Redis {
    loginFailRecord(key: string, ttlSeconds: string): Promise<number>;
  }
}

/** One failure counter and the count at which it locks. */
interface LoginBucket {
  key: string;
  threshold: number;
}

/**
 * Account-aware login brute-force protection (FND-008, refactored under
 * 009-auth-abuse-resistance / ZT-002 for a bounded degraded-mode fallback).
 *
 * The counter's identity is the normalised submitted email — trimmed and
 * lower-cased the SAME way {@link AuthService.normalizeEmail} normalises it
 * before account lookup, so the two can never disagree — and is deliberately
 * INDEPENDENT of any tenant qualifier: `tenantSlug` is optional and
 * caller-supplied, so keying on it would let an attacker rotate or omit it
 * to get a fresh bucket per variant (research §R2a).
 *
 * Runs on `AppRedisService.rateLimiter` — the dedicated, fail-fast connection
 * (`commandTimeout`, no offline queue) built specifically so a caller's
 * "Redis unavailable" branch actually executes during an outage instead of
 * hanging on the buffered producer connection.
 *
 * **ZT-002 — why this does not inject `FixedWindowLimiterService`.** The
 * healthy path below is required to stay byte-identical (FR-024, tasks.md
 * T043/T046), and `login-protection.service.spec.ts` — the regression
 * oracle T046 pins — directly mocks `appRedis.rateLimiter.{get,del,
 * loginFailRecord,defineCommand}` and constructs this service with exactly
 * its existing three constructor arguments. Changing the constructor to
 * receive `FixedWindowLimiterService` instead of `AppRedisService` would
 * change that mocking surface and break the frozen spec, which is precisely
 * the "healthy behaviour changed" outcome T046 forbids. This service
 * therefore keeps talking to `appRedis.rateLimiter` directly for its healthy
 * path (unchanged from before this feature) and constructs its OWN
 * {@link BoundedLocalCounter} — the SAME shared primitive class
 * `FixedWindowLimiterService` uses for its own fallback — for the degraded
 * path only. The two share the primitive, not a service instance.
 */
@Injectable()
export class LoginProtectionService {
  private readonly logger = new Logger(LoginProtectionService.name);
  private readonly degradedLog = new DegradedModeLogLimiter(this.logger, 'Login protection store');

  // KEYS: [counterKey]
  // ARGV: [ttlSeconds]
  //
  // Atomic increment-and-conditional-expire in a SINGLE round-trip. The TTL
  // is set ONLY when this increment creates the key (result === 1) and is
  // NEVER touched on any later call — this single property is what makes
  // "no permanent lockout" (FR-019, SR-006) structural rather than a
  // promise:
  //   - A separate `INCR` then `EXPIRE` is two commands. A crash between
  //     them leaves a key with NO TTL at all — a permanently locked account.
  //   - A "refresh the TTL on every failure" (sliding-window) design would
  //     let an attacker who keeps failing hold a chosen account locked
  //     FOREVER — exactly the denial of service this control must not cause.
  // With a fixed window anchored at the FIRST failure, a continuously
  // attacking adversary still yields: the key expires N seconds after that
  // first failure regardless of later traffic, and the legitimate owner can
  // authenticate again.
  private static readonly RECORD_FAILURE_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  /**
   * Bounded degraded-mode fallback (ZT-002, FR-025a) — used ONLY when
   * `appRedis.rateLimiter` errors. Allocated once at construction, sized
   * from `AUTH_ABUSE_FALLBACK_WIDTH`, windowed at the SAME TTL as the
   * healthy path so a degraded episode roughly tracks the same lockout
   * duration. No Map, no timer — see BoundedLocalCounter's own invariants.
   */
  private readonly fallback: BoundedLocalCounter;

  constructor(
    private readonly appRedis: AppRedisService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.appRedis.rateLimiter.defineCommand('loginFailRecord', {
      numberOfKeys: 1,
      lua: LoginProtectionService.RECORD_FAILURE_SCRIPT,
    });
    this.fallback = new BoundedLocalCounter({
      width: this.config.get<number>('AUTH_ABUSE_FALLBACK_WIDTH', 4096),
      depth: 3,
      windowMs: this.ttlSeconds() * 1000,
    });
  }

  /**
   * Read-only lockout check. Performs NO write of any kind, so calling this
   * on an already-locked identity can never accidentally touch its TTL.
   * MUST be called before credential validation (see AuthService.login) so
   * the response is identical whether or not the account actually exists.
   */
  async isLocked(identity: string, client?: string): Promise<boolean> {
    const buckets = this.bucketsFor(identity, client);
    try {
      let locked = false;
      for (const bucket of buckets) {
        const raw = await this.appRedis.rateLimiter.get(bucket.key);
        const count = raw ? Number(raw) : 0;
        if (count >= bucket.threshold) locked = true;
      }
      this.degradedLog.recordSuccess();
      if (locked) this.metrics.recordLoginProtectionEvent('blocked');
      return locked;
    } catch (err) {
      return this.degradedIsLocked(buckets, err);
    }
  }

  /**
   * Called only on a credential-validation failure — never on a lockout
   * refusal. Returns `true` exactly on the call that crosses the threshold
   * (the "engaged" transition), so the caller can write a single audit
   * record for it rather than one per failed attempt.
   */
  async recordFailure(identity: string, client?: string): Promise<boolean> {
    const buckets = this.bucketsFor(identity, client);
    try {
      let justEngaged = false;
      for (const bucket of buckets) {
        const count = await this.appRedis.rateLimiter.loginFailRecord(
          bucket.key,
          String(this.ttlSeconds()),
        );
        if (count === bucket.threshold) justEngaged = true;
      }
      this.degradedLog.recordSuccess();
      if (justEngaged) {
        this.metrics.recordLoginProtectionEvent('engaged');
      }
      return justEngaged;
    } catch (err) {
      return this.degradedRecordFailure(buckets, err);
    }
  }

  /**
   * Called on every successful authentication — fully clears the count,
   * never decrements. Returns `true` only when an active failure count
   * actually existed to clear, so the caller can audit a meaningful
   * "recovery" event rather than one row per ordinary successful login.
   */
  async clear(identity: string, client?: string): Promise<boolean> {
    const keys = this.bucketsFor(identity, client).map((b) => b.key);
    try {
      const removed = await this.appRedis.rateLimiter.del(...keys);
      this.degradedLog.recordSuccess();
      const hadState = Number(removed) > 0;
      if (hadState) {
        this.metrics.recordLoginProtectionEvent('cleared');
      }
      return hadState;
    } catch (err) {
      this.failOpenClear(err);
      // Degraded mode intentionally does NOT report "had state to clear" —
      // unlike isLocked/recordFailure, there is no local state this
      // operation is safe to reset: BoundedLocalCounter deliberately has no
      // decrement/reset operation (a reset keyed on one caller's identity
      // could, under a hash collision, silently under-count an unrelated
      // colliding identity — see that class's own invariants). The local
      // degraded count for a just-authenticated user is therefore left to
      // age out naturally via window rotation; this is strictly SAFER (an
      // occasional extra degraded_refused for a user who just succeeded is
      // over-cautious, never a security gap) than trying to clear it.
      return false;
    }
  }

  /**
   * The Redis key: namespaced via the existing `cacheKeyPrefix()` helper so
   * it cannot collide with the global throttler's keys or any cache key, and
   * holding a SHA-256 hash of the identity rather than the raw email — Redis
   * keys surface in `MONITOR`, `SLOWLOG`, `--bigkeys` and RDB/AOF dumps, and
   * the counter never needs to read the address back. Reused verbatim as the
   * degraded-mode fallback's key (BoundedLocalCounter hashes it again
   * internally) — the same hashed identity, one derivation, two consumers.
   */
  private keyFor(identity: string): string {
    const normalized = identity.trim().toLowerCase();
    const hash = createHash('sha256').update(normalized).digest('hex');
    return `${cacheKeyPrefix()}auth:login:fail:${hash}`;
  }

  /**
   * RL-05 — the counters one attempt touches. Without a client address the
   * email alone is locked at the normal threshold (the original behaviour).
   * With one, the normal threshold applies to (email + client), so failures
   * sent from an attacker's address no longer lock the owner out from
   * theirs, and the email alone keeps a higher backstop so rotating
   * addresses still cannot guess without bound.
   *
   * `client` must be the trusted-proxy-resolved address (`req.ip` under
   * `TRUST_PROXY_HOPS`), never a raw header — a forgeable value would give
   * an attacker a fresh pair bucket per request and leave only the backstop.
   */
  private bucketsFor(identity: string, client?: string): LoginBucket[] {
    const emailKey = this.keyFor(identity);
    const address = client?.trim().replace(/^::ffff:/, '');
    if (!address) return [{ key: emailKey, threshold: this.threshold() }];
    const normalized = identity.trim().toLowerCase();
    const pairHash = createHash('sha256')
      .update(`${normalized}\n${address}`)
      .digest('hex');
    return [
      {
        key: `${cacheKeyPrefix()}auth:login:fail:pair:${pairHash}`,
        threshold: this.threshold(),
      },
      { key: emailKey, threshold: this.identityBackstop() },
    ];
  }

  private threshold(): number {
    return this.config.get<number>('AUTH_LOGIN_MAX_FAILED_ATTEMPTS', 5);
  }

  /** Email-wide ceiling when a client address is known; never below the per-pair threshold. */
  private identityBackstop(): number {
    const backstop = this.config.get<number>(
      'AUTH_LOGIN_IDENTITY_BACKSTOP_ATTEMPTS',
      20,
    );
    return Math.max(this.threshold(), backstop);
  }

  private ttlSeconds(): number {
    return this.config.get<number>('AUTH_LOGIN_LOCKOUT_TTL_SECONDS', 900);
  }

  /** Degraded-mode limit — always stricter than or equal to the healthy threshold (FR-028a). */
  private degradedThreshold(threshold: number): number {
    const factor = this.config.get<number>('AUTH_ABUSE_DEGRADED_FACTOR', 0.5);
    return Math.max(1, Math.ceil(threshold * factor));
  }

  /**
   * Degraded read-only lockout check (ZT-002, FR-025a, FR-027). A Redis
   * outage no longer means unlimited attempts (isLocked used to
   * unconditionally return `false`) — it means the BOUNDED local fallback
   * decides, at a stricter limit. An identity with no locally-recorded
   * failures (the common case: most users, most of the time) still reads as
   * not-locked, so a legitimate login is never denied by the outage itself.
   */
  private degradedIsLocked(buckets: LoginBucket[], err: unknown): boolean {
    this.failOpenIsLocked(err);
    const locked = buckets.some(
      (b) => this.fallback.peek(b.key) >= this.degradedThreshold(b.threshold),
    );
    this.metrics.recordAuthAbuseLimiterEvent('login', locked ? 'degraded_refused' : 'degraded_allowed');
    return locked;
  }

  /** Degraded failure recording — increments the SAME bounded local table isLocked() reads. */
  private degradedRecordFailure(buckets: LoginBucket[], err: unknown): boolean {
    this.failOpenRecordFailure(err);
    let justEngaged = false;
    for (const bucket of buckets) {
      const count = this.fallback.increment(bucket.key);
      if (count === this.degradedThreshold(bucket.threshold))
        justEngaged = true;
    }
    return justEngaged;
  }

  /**
   * FAIL OPEN on any store error (FR-020): the caller proceeds to normal
   * credential validation rather than being unconditionally refused or
   * unconditionally admitted — the bounded local fallback above makes the
   * actual decision. Failing closed would convert a Redis outage into a
   * total authentication outage — itself the denial of service FR-019/
   * SR-006 forbid, and the global per-IP throttle already shares this same
   * Redis dependency (app.module.ts), so this does not newly widen the
   * platform's exposure to a Redis outage.
   *
   * The warning + counter (FR-020a) make the gap LOUD rather than silent —
   * no email, identity hash, or credential is included, only the store's
   * own error text. Logging is rate-limited (FR-035/SC-012) so a sustained
   * outage does not emit one line per request; the metric counter still
   * fires on every call, unchanged.
   */
  private failOpenIsLocked(err: unknown): void {
    this.recordStoreUnavailable(err);
  }

  private failOpenRecordFailure(err: unknown): void {
    this.recordStoreUnavailable(err);
  }

  private failOpenClear(err: unknown): void {
    this.recordStoreUnavailable(err);
  }

  private recordStoreUnavailable(err: unknown): void {
    this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
    this.metrics.recordLoginProtectionEvent('store_unavailable');
  }
}
