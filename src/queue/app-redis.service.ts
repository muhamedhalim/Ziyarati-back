import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
export class AppRedisService implements OnModuleDestroy {
  private readonly logger = new Logger('AppRedisService');
  readonly application: Redis;
  readonly rateLimiter: Redis;

  constructor(config: ConfigService) {
    this.application = this.build(applicationConnectionOptions(config), 'application');
    this.rateLimiter = this.build(rateLimiterConnectionOptions(config), 'rate-limiter');
    this.checkMaxmemoryPolicy();
  }

  private build(options: ReturnType<typeof applicationConnectionOptions>, label: string): Redis {
    const client = new Redis({ ...options, lazyConnect: true });
    client.on('error', (err) => this.logger.warn(`Redis ${label} client error (non-fatal, call sites fail open/closed per their own policy): ${err.message}`));
    client.connect().catch((err) => this.logger.warn(`Redis ${label} client initial connect failed: ${err.message}`));
    return client;
  }

  /**
   * Non-fatal boot-time warning (Phase 0 — see docs/CACHING_QUEUES_AUDIT.md
   * §0.5 / original audit C1): this Redis holds BullMQ job state alongside
   * caches, so an eviction policy (`allkeys-*`/`volatile-*`) can silently drop
   * queued jobs under memory pressure. Logs a loud warning rather than
   * refusing to boot — an existing deployment may have a deliberate reason,
   * and failing hard here would be its own outage. `CONFIG GET` is best-effort:
   * some managed Redis providers disable it for non-admin users, in which case
   * this silently skips (logged at debug, not warn).
   */
  private checkMaxmemoryPolicy(): void {
    this.application
      .config('GET', 'maxmemory-policy')
      .then((res) => {
        const policy = Array.isArray(res) ? res[1] : undefined;
        if (policy && policy !== 'noeviction') {
          this.logger.warn(
            `⚠️  Redis maxmemory-policy is "${policy}", not "noeviction". This Redis holds ` +
              'BullMQ queue state — an eviction policy can silently drop queued jobs under memory ' +
              'pressure, with no error and no DLQ entry. See docs/REDIS_CAPACITY.md before changing ' +
              'this in production, or split queue/cache onto separate Redis instances/databases.',
          );
        }
      })
      .catch((err) => this.logger.debug(`maxmemory-policy check skipped: ${(err as Error).message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.application.quit().catch(() => undefined), this.rateLimiter.quit().catch(() => undefined)]);
  }
}
