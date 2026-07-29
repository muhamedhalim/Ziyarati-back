import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AppRedisService } from './app-redis.service';

/**
 * Real distributed lock: `SET key token NX PX ttl` to acquire, a Lua
 * compare-and-delete to release (never deletes a lock this caller doesn't
 * still own — a slow holder whose TTL already expired must not have its
 * *replacement* holder's lock stolen out from under it).
 *
 * Built for the integration `recoverStale()` sweep (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.8): no queue in this codebase sets
 * `lockDuration`/`stalledInterval`, so BullMQ's default 30s lock can let its
 * OWN stall detector hand a long-running sweep job to a second worker while
 * the first is still mid-sweep — a real double-execution path the repeat-key
 * dedup on `ScheduleRegistrarService`'s registration does NOT cover (that only
 * prevents duplicate *schedules*, not a stalled job being redelivered). This
 * lock guards against that specific case.
 *
 * Deliberately generic (not folded into `TenantRateLimiterService`'s
 * rate-limiter-as-mutex, which the main audit's H11 already flags as broken —
 * no ownership token, no renewal, a no-op release) so it can later become
 * H11's replacement primitive too — that migration is out of scope for this
 * pass and tracked separately.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger('DistributedLock');

  /** Lua release: only deletes the key if it still holds THIS caller's token. */
  private static readonly RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(private readonly redis: AppRedisService) {}

  /** Attempts to acquire `key` for `ttlMs`. Returns an ownership token on success, or `null` if already held. */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    try {
      const result = await this.redis.application.set(key, token, 'PX', ttlMs, 'NX');
      return result === 'OK' ? token : null;
    } catch (err) {
      this.logger.warn(`lock acquire failed for "${key}" (treated as not-acquired): ${(err as Error)?.message}`);
      return null;
    }
  }

  /** Releases `key` ONLY if `token` still matches — a no-op if the lock already expired and was reclaimed by someone else. */
  async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.application.eval(DistributedLockService.RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      this.logger.warn(`lock release failed for "${key}" (will self-expire via TTL): ${(err as Error)?.message}`);
    }
  }
}
