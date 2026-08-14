import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { cacheConnectionOptions } from '../../queue/redis.config';

/** Redis pub/sub channel every replica listens on for access invalidations. */
export const ACCESS_INVALIDATION_CHANNEL = 'ziyara:access:invalidated';

/**
 * Short-lived cache of the reads backing an access decision, with cross-replica
 * invalidation (plan §16).
 *
 * WHY A CACHE AT ALL. Resolving one capability costs four reads (billing mode,
 * free-access override, subscription, flag states) plus two catalog reads.
 * Every gated request pays it, and `FeatureResolverService` pays it again for
 * the whole catalog. The per-request memo (`guards/request-access.ts`) already
 * collapses the duplicate resolution WITHIN one request; this collapses it
 * across the burst of requests a single page load produces.
 *
 * WHY IT IS SAFE. Three rules, in order of importance:
 *
 *  1. **Caching may never extend a grant.** The TTL is 5 seconds — short
 *     enough that a missed invalidation self-heals inside one page load — and
 *     every mutation that can change a decision publishes an invalidation.
 *  2. **A cache failure resolves FRESH, never open.** Every read path treats a
 *     miss, an expiry, a Redis outage and a deserialization problem
 *     identically: go to the database. There is no branch anywhere in this
 *     class that returns "allowed" on its own.
 *  3. **Transactions never read the cache.** `AccessControlService` skips this
 *     entirely when a caller passes an `EntityManager` — inside a transaction
 *     the caller may have just written the very flag being resolved, and must
 *     observe its own write.
 *
 * WHY ITS OWN REDIS CLIENTS RATHER THAN `AppRedisService`. `QueueModule` (which
 * provides `AppRedisService`) imports `SubscriptionBillingModule` for the worker
 * entitlement gate, so injecting that service here would be a genuine
 * provider-level cycle — @Global exports do not exempt a provider from the
 * instantiation order of the module that declares it. `redis.config.ts` is a
 * pure options module with no Nest dependencies, so building the pair directly
 * from `cacheConnectionOptions` costs two connections and creates no cycle at
 * all. A subscriber cannot issue normal commands anyway, so a dedicated one was
 * always required.
 *
 * When Redis is unreachable (unit tests, a single-process dev box) the class
 * stays fully functional as a per-process TTL cache; it simply loses the
 * cross-replica bust, which the TTL already bounds.
 */
@Injectable()
export class AccessCacheService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('AccessCache');
  private readonly ttlMs: number;
  private readonly enabled: boolean;

  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  /** Dedicated subscriber — a Redis connection in subscriber mode cannot issue
   *  normal commands, so it must never be the shared application client. */
  private subscriber?: Redis;
  private publisher?: Redis;

  private static readonly MAX_ENTRIES = 10_000;

  constructor(private readonly config: ConfigService) {
    this.ttlMs = Number(
      this.config.get<string>('ACCESS_DECISION_CACHE_TTL_MS') ?? 5_000,
    );
    // A zero/negative TTL is a supported way to switch the cache off entirely
    // (e.g. while diagnosing an entitlement incident) without a code change.
    this.enabled = Number.isFinite(this.ttlMs) && this.ttlMs > 0;
    if (!this.enabled) {
      this.logger.log(
        'Access decision cache DISABLED (ACCESS_DECISION_CACHE_TTL_MS <= 0) — every gate resolves fresh.',
      );
    }
  }

  /**
   * Wires cross-replica invalidation. Best-effort by design: a replica that
   * cannot reach Redis keeps its 5s TTL cache and logs once. Failing boot here
   * would take the API down over a cache, and the TTL already bounds the
   * staleness this would otherwise prevent.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const options = cacheConnectionOptions(this.config);
    // Held in locals and assigned to the fields only once BOTH are subscribed:
    // a failure partway through must not leave two sockets nothing owns and
    // `onModuleDestroy` cannot reach — the `finally`-shaped catch below closes
    // exactly that window.
    const publisher = new Redis({ ...options, lazyConnect: true });
    const subscriber = new Redis({ ...options, lazyConnect: true });
    try {
      for (const [client, label] of [
        [publisher, 'publisher'],
        [subscriber, 'subscriber'],
      ] as const) {
        client.on('error', (err: Error) =>
          this.logger.warn(
            `access invalidation ${label} error: ${err.message} — the ${this.ttlMs}ms TTL still bounds staleness.`,
          ),
        );
      }
      subscriber.on('message', (channel: string, payload: string) => {
        if (channel !== ACCESS_INVALIDATION_CHANNEL) return;
        this.applyRemoteInvalidation(payload);
      });
      await Promise.all([publisher.connect(), subscriber.connect()]);
      await subscriber.subscribe(ACCESS_INVALIDATION_CHANNEL);
      this.publisher = publisher;
      this.subscriber = subscriber;
      this.logger.log(
        `Access invalidation subscribed on "${ACCESS_INVALIDATION_CHANNEL}" (ttl=${this.ttlMs}ms)`,
      );
    } catch (err) {
      await this.quiet(publisher, subscriber);
      this.logger.warn(
        `Cross-replica access invalidation unavailable (${(err as Error)?.message}) — ` +
          `falling back to the ${this.ttlMs}ms per-process TTL, which still bounds staleness.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.quiet(this.publisher, this.subscriber);
    this.publisher = undefined;
    this.subscriber = undefined;
  }

  /**
   * Closes clients without letting a shutdown failure propagate.
   *
   * `disconnect()` after `quit()` because a client that never reached READY
   * (Redis unreachable at boot) has no connection to send QUIT over, so `quit`
   * rejects and the socket — and its reconnect timer — would stay open,
   * holding the process alive.
   */
  private async quiet(...clients: (Redis | undefined)[]): Promise<void> {
    await Promise.all(
      clients.filter(Boolean).map(async (client) => {
        await client!.quit().catch(() => undefined);
        client!.disconnect();
      }),
    );
  }

  /** Cached value for a tenant, or `undefined` on miss/expiry/disabled. */
  get<T>(tenantId: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(tenantId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(tenantId);
      return undefined;
    }
    return entry.value as T;
  }

  set(tenantId: string, value: unknown): void {
    if (!this.enabled) return;
    // Bounded. Under a large tenant fan-out (the platform usage listing walks
    // every tenant) this map would otherwise grow to the size of the customer
    // base; dropping the oldest costs one extra resolve.
    if (this.entries.size >= AccessCacheService.MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(tenantId, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Drops a tenant's cached decision here AND on every other replica.
   *
   * Called by every mutation that can change an access decision — feature
   * grants, suspensions, free-access grants/revocations, subscription
   * lifecycle, plan entitlement, the dependency catalog, and billing mode.
   * Local first, so the replica that performed the write is correct even if the
   * publish fails; the publish is then best-effort and never propagates an
   * error into the mutation that triggered it (a failed cache bust must not
   * roll back a super-admin's suspension).
   */
  invalidate(tenantId: string): void {
    this.entries.delete(tenantId);
    this.publish(tenantId);
  }

  /** Drops everything — for platform-wide changes such as billing mode. */
  invalidateAll(): void {
    this.entries.clear();
    this.publish('*');
  }

  private publish(tenantId: string): void {
    if (!this.publisher) return;
    this.publisher
      .publish(ACCESS_INVALIDATION_CHANNEL, tenantId)
      .catch((err: Error) =>
        this.logger.warn(
          `access invalidation publish failed for "${tenantId}" (${err.message}) — ` +
            'other replicas will self-heal within the TTL.',
        ),
      );
  }

  private applyRemoteInvalidation(payload: string): void {
    if (payload === '*') {
      this.entries.clear();
      return;
    }
    this.entries.delete(payload);
  }
}
