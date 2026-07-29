import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { applicationConnectionOptions, rateLimiterConnectionOptions } from './redis.config';

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

  constructor(
    private readonly config: ConfigService,
  ) {
    this.application = this.build(applicationConnectionOptions(config), 'application');
    this.rateLimiter = this.build(rateLimiterConnectionOptions(config), 'rate-limiter');
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
    this.allowUnsafeMemoryConfig = config.get<string>('REDIS_ALLOW_UNSAFE_MEMORY_CONFIG') === 'true';
  }

  private build(options: ReturnType<typeof applicationConnectionOptions>, label: string): Redis {
    const client = new Redis({ ...options, lazyConnect: true });
    client.on('error', (err) => this.logger.warn(`Redis ${label} client error (non-fatal, call sites fail open/closed per their own policy): ${err.message}`));
    client.connect().catch((err) => this.logger.warn(`Redis ${label} client initial connect failed: ${err.message}`));
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
   * only warns, so local/staging work is never blocked by this. `CONFIG GET`
   * is best-effort: some managed Redis providers disable it for non-admin
   * users, in which case this silently skips (logged at debug), in EVERY
   * environment including production — enforcing a check that structurally
   * cannot run would only turn "managed Redis" into "can never deploy".
   */
  private async checkMaxmemoryPolicy(): Promise<void> {
    let res: unknown;
    try {
      res = await this.application.config('GET', 'maxmemory-policy');
    } catch (err) {
      this.logger.debug(`maxmemory-policy check skipped: ${(err as Error).message}`);
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
   * production-fail / escape-hatch / best-effort-CONFIG-GET rules as
   * `checkMaxmemoryPolicy`.
   */
  private async checkMaxmemoryCeiling(): Promise<void> {
    let res: unknown;
    try {
      res = await this.application.config('GET', 'maxmemory');
    } catch (err) {
      this.logger.debug(`maxmemory ceiling check skipped: ${(err as Error).message}`);
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

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.application.quit().catch(() => undefined), this.rateLimiter.quit().catch(() => undefined)]);
  }
}
