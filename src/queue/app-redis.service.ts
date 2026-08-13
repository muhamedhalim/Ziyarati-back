import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import {
  applicationConnectionOptions,
  rateLimiterConnectionOptions,
} from './redis.config';
import { DegradedModeLogLimiter } from './degraded-mode-log-limiter';

/**
 * Owns the two "small" Redis roles that used to silently ride the BullMQ
 * producer connection: plain KV/health-check commands (`application`) and the
 * per-tenant rate-limiter Lua script (`rateLimiter`).
 *
 * Both profiles are fail-fast (`commandTimeout`, no offline queue — see
 * redis.config.ts) so every call site's existing "fail open on Redis error"
 * branch actually runs within ~2s instead of inheriting the producer
 * connection's ~60-80s buffered-retry behaviour (Phase 0 correction, see
 * docs/CACHING_QUEUES_AUDIT.md §0.2/§0.5).
 *
 * `@Global` via QueueModule, same as QueueService — both process roots (API
 * and worker) need it, since kvSet/kvGet and the rate limiter are called from
 * both sides (e.g. FinancialMetricsService's reaper heartbeat runs in the
 * worker).
 */
@Injectable()
export class AppRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AppRedisService');
  readonly application: Redis;
  readonly rateLimiter: Redis;
  private readonly isProduction: boolean;
  private readonly allowUnsafeMemoryConfig: boolean;
  private readonly verifiedViaIac: boolean;

  constructor(private readonly config: ConfigService) {
    this.application = this.build(
      applicationConnectionOptions(config),
      'application',
    );
    this.rateLimiter = this.build(
      rateLimiterConnectionOptions(config),
      'rate-limiter',
    );
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
    this.allowUnsafeMemoryConfig =
      config.get<string>('REDIS_ALLOW_UNSAFE_MEMORY_CONFIG') === 'true';
    this.verifiedViaIac =
      config.get<string>('REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC') === 'true';
  }

  private build(
    options: ReturnType<typeof applicationConnectionOptions>,
    label: string,
  ): Redis {
    const client = new Redis({ ...options, lazyConnect: true });
    // 009-auth-abuse-resistance (ZT-002, FR-035/SC-012): a sustained outage
    // makes ioredis emit repeated 'error' events (one per failed
    // reconnect/command) — previously one `logger.warn` per event, at least
    // one more log source alongside FailsafeThrottlerStorage's own
    // per-request warning. Rate-limited the same way: one line entering
    // degraded mode, at most one summary per interval, one line on 'ready'
    // (ioredis's own recovery signal).
    const degradedLog = new DegradedModeLogLimiter(
      this.logger,
      `Redis ${label} client`,
    );
    client.on('error', (err) => degradedLog.recordFailure(err.message));
    client.on('ready', () => degradedLog.recordSuccess());
    client
      .connect()
      .catch((err) =>
        this.logger.warn(
          `Redis ${label} client initial connect failed: ${err.message}`,
        ),
      );
    return client;
  }

  /**
   * Runs the maxmemory checks as a REAL, awaited Nest lifecycle hook (gap-
   * closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.9) instead of
   * fire-and-forget from the constructor. Two things this fixes at once:
   *  1. The constructor's `client.connect()` is itself fire-and-forget, so the
   *     old code could call `CONFIG GET` before the client was ready — with
   *     `enableOfflineQueue: false` (fail-fast profile) that rejects
   *     immediately, so the checks could silently never actually run.
   *  2. `onModuleInit` is AWAITED by Nest during app bootstrap — a throw here
   *     genuinely fails `app.listen()`/`app.init()`, which is what makes
   *     "enforce" mean something. The old version could only ever log.
   */
  async onModuleInit(): Promise<void> {
    const ready = await this.waitReady(this.application, 5000);
    if (!ready) {
      this.logger.warn(
        'Redis application client was not ready within 5s at boot — skipping the maxmemory-policy/ceiling checks this run.',
      );
      return;
    }
    await this.checkMaxmemoryPolicy();
    await this.checkMaxmemoryCeiling();
  }

  private waitReady(client: Redis, timeoutMs: number): Promise<boolean> {
    if (client.status === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        client.off('ready', onReady);
      };
      const onReady = () => {
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      client.once('ready', onReady);
    });
  }

  /**
   * PRODUCTION ENFORCEMENT (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.9 — replaces the previous warn-only
   * behaviour, original audit C1): this Redis holds BullMQ job state alongside
   * caches, so an eviction policy (`allkeys-*`/`volatile-*`) can silently drop
   * queued jobs under memory pressure. In production this now FAILS BOOT
   * unless `REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true` is explicitly set (an
   * operator with a deliberate, reviewed reason) — outside production it still
   * only warns, so local/staging work is never blocked by this.
   *
   * `CONFIG GET` BLOCKED (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.11 — replaces the previous silent-skip
   * behaviour): some managed Redis providers (e.g. ElastiCache, Upstash,
   * Memorystore under certain tiers) disable `CONFIG GET` for non-admin
   * users, in which case this check structurally cannot run at all. The
   * PREVIOUS version treated that identically to "checked and found safe" —
   * a debug-level log line, easy to miss, silently bypassing the very
   * enforcement this method exists for. It now fails boot in production
   * UNLESS the operator has explicitly attested — via
   * `REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true` — that maxmemory-policy/
   * maxmemory were verified some OTHER way (Terraform/CloudFormation output,
   * the provider's own console, a provisioning script) — see
   * `checkConfigGetBlocked` for the shared logic. Outside production this
   * still only warns, exactly like a genuinely-unsafe policy would.
   */
  private async checkMaxmemoryPolicy(): Promise<void> {
    let res: unknown;
    try {
      res = await this.application.config('GET', 'maxmemory-policy');
    } catch (err) {
      this.checkConfigGetBlocked('maxmemory-policy', err as Error);
      return;
    }
    const policy = Array.isArray(res) ? res[1] : undefined;
    if (!policy || policy === 'noeviction') return;

    const message =
      `Redis maxmemory-policy is "${policy}", not "noeviction". This Redis holds BullMQ queue state — ` +
      'an eviction policy can silently drop queued jobs under memory pressure, with no error and no DLQ ' +
      'entry. See docs/REDIS_CAPACITY.md before changing this in production, or split queue/cache onto ' +
      'separate Redis instances/databases.';

    if (this.isProduction && !this.allowUnsafeMemoryConfig) {
      throw new Error(
        `❌ ${message} Refusing to boot in production. Set REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true to ` +
          'override once you have deliberately reviewed and accepted this risk.',
      );
    }
    this.logger.warn(`⚠️  ${message}`);
  }

  /**
   * PRODUCTION ENFORCEMENT (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.9): `noeviction` has nothing to enforce
   * against without an actual `maxmemory` ceiling — `0` means unlimited, which
   * in production means an out-of-memory condition is whatever the HOST runs
   * out of, not something Redis itself ever rejects a write for. Same
   * production-fail / escape-hatch / CONFIG-GET-blocked rules as
   * `checkMaxmemoryPolicy` — see `checkConfigGetBlocked`.
   */
  private async checkMaxmemoryCeiling(): Promise<void> {
    let res: unknown;
    try {
      res = await this.application.config('GET', 'maxmemory');
    } catch (err) {
      this.checkConfigGetBlocked('maxmemory', err as Error);
      return;
    }
    const raw = Array.isArray(res) ? res[1] : undefined;
    const bytes = Number(raw ?? 0);
    if (Number.isFinite(bytes) && bytes > 0) return;

    const message =
      'Redis maxmemory is unset/unlimited (0). "noeviction" cannot reject writes before running out of ' +
      'space if there is no ceiling to hit — size this from real measured traffic per docs/REDIS_CAPACITY.md.';

    if (this.isProduction && !this.allowUnsafeMemoryConfig) {
      throw new Error(
        `❌ ${message} Refusing to boot in production. Set REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true to ` +
          'override once you have deliberately reviewed and accepted this risk.',
      );
    }
    if (this.isProduction) this.logger.warn(`⚠️  ${message}`);
  }

  /**
   * Shared handling for a `CONFIG GET` call that failed outright (managed
   * Redis with the command disabled, insufficient ACL, etc.) — as opposed to
   * one that SUCCEEDED and returned an unsafe value, which the two callers
   * handle themselves. This is deliberately NOT a silent skip in production
   * (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11): a check that
   * structurally cannot run is not evidence of safety, and treating it as
   * such was the actual gap. `REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true` is
   * the escape hatch — an explicit, logged, operator-supplied attestation
   * that the setting was verified some OTHER way (provider console, IaC
   * output), so the absence of a runtime check is a recorded decision, not an
   * accident. `REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true` also satisfies this (an
   * operator who has already accepted the risk of an unsafe config has, by
   * definition, also accepted not being able to verify it).
   */
  private checkConfigGetBlocked(setting: string, err: Error): void {
    if (!this.isProduction) {
      this.logger.debug(
        `${setting} check skipped (non-production): ${err.message}`,
      );
      return;
    }
    if (this.verifiedViaIac || this.allowUnsafeMemoryConfig) {
      this.logger.log(
        `Redis ${setting} could not be checked via CONFIG GET (${err.message}) — proceeding because ` +
          `${this.verifiedViaIac ? 'REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true (operator attested it was verified out-of-band)' : 'REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true'}.`,
      );
      return;
    }
    throw new Error(
      `❌ Redis ${setting} could not be verified via CONFIG GET in production (${err.message}) — likely a ` +
        'managed Redis provider with CONFIG GET disabled for this user. Refusing to boot rather than silently ' +
        'assume the setting is safe. Either grant CONFIG GET access, set ' +
        'REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC=true after verifying maxmemory-policy/maxmemory some other way ' +
        '(provider console, Terraform/CloudFormation output), or set REDIS_ALLOW_UNSAFE_MEMORY_CONFIG=true to ' +
        'accept the risk outright.',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.application.quit().catch(() => undefined),
      this.rateLimiter.quit().catch(() => undefined),
    ]);
  }
}
