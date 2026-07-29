import { ConfigService } from '@nestjs/config';
import { RedisOptions } from 'ioredis';

/**
 * Build ioredis connection options from **REDIS_URL only**.
 *
 * Supports `redis://` and `rediss://` (TLS) and parses host/port/credentials/db
 * from the URL — so the exact same code works unchanged against Railway Redis,
 * Upstash, AWS ElastiCache, or a local Redis. There is no hardcoded host/port
 * and no localhost assumption anywhere.
 *
 * Three roles need DISTINCT connections (BullMQ requirement): the shared
 * producer connection, each Worker's blocking connection, and the QueueEvents
 * connection. Use the role-specific helpers below so each gets correct options:
 *  - `maxRetriesPerRequest: null` is REQUIRED for blocking (worker/events) roles.
 *  - producers keep the offline queue so enqueues survive brief Redis blips.
 */
function baseOptions(config: ConfigService): RedisOptions {
  const url = config.get<string>('REDIS_URL');
  if (!url || url.trim().length === 0) {
    throw new Error(
      '❌ REDIS_URL is required for the background-job subsystem (BullMQ).',
    );
  }

  const parsed = new URL(url);
  const isTls = parsed.protocol === 'rediss:';
  const db =
    parsed.pathname && parsed.pathname.length > 1
      ? Number(parsed.pathname.slice(1))
      : 0;

  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isFinite(db) ? db : 0,
    enableReadyCheck: true,
    connectTimeout: 10_000,
    keepAlive: 30_000, // survive NAT/LB idle timeouts (Railway/ElastiCache)
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    reconnectOnError: (err: Error) => err.message.includes('READONLY'), // failover
  };
  if (isTls) options.tls = {};
  return options;
}

/**
 * PRODUCER connection (HTTP API + relay enqueues). Keeps the offline queue so a
 * brief Redis blip buffers `add()` calls instead of throwing. Default
 * `maxRetriesPerRequest` is fine for non-blocking producer commands.
 *
 * Deliberately NO `commandTimeout` here (Phase 0 correction — see
 * docs/CACHING_QUEUES_AUDIT.md §0.2): a hard timeout would turn a transient
 * Redis blip into a failed enqueue instead of one the offline queue buffers,
 * which is the opposite of what this profile is for.
 */
export function producerConnectionOptions(config: ConfigService): RedisOptions {
  return { ...baseOptions(config), enableOfflineQueue: true, connectionName: 'bullmq:producer' };
}

/**
 * BLOCKING connection (Workers + QueueEvents). BullMQ mandates
 * `maxRetriesPerRequest: null` here — its blocking commands must never be
 * aborted mid-wait.
 *
 * Deliberately NO `commandTimeout` here either (same Phase 0 correction): a
 * command timeout on a blocking connection would race BullMQ's own internal
 * lock-renewal/blocking-read timers and risks a Worker silently losing its job
 * lock mid-processing — precisely the failure class this audit is trying to
 * prevent, not cause. Application-level fail-fast behaviour belongs on the
 * `application`/`rateLimiter`/`cache` profiles below, never here.
 */
export function blockingConnectionOptions(config: ConfigService): RedisOptions {
  // `maxRetriesPerRequest: null` is mandatory for BullMQ blocking roles. Offline
  // queue is left enabled because this profile is also the shared default the
  // API producers use — buffering their enqueues across brief blips.
  return {
    ...baseOptions(config),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectionName: 'bullmq:worker',
  };
}

/**
 * QUEUEEVENTS connection (the monitor's pub/sub listener). Like the blocking
 * profile it needs `maxRetriesPerRequest: null`, but it is read-only (never
 * enqueues) so the offline queue is disabled. A distinct instance keeps the
 * monitor's blocking `XREAD`/subscribe loop off the producer and worker sockets.
 * No `commandTimeout` for the same reason as the blocking profile.
 */
export function eventsConnectionOptions(config: ConfigService): RedisOptions {
  return {
    ...baseOptions(config),
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectionName: 'bullmq:events',
  };
}

/**
 * APPLICATION commands (the plain KV helpers: health-check `PING`, and the
 * generic `kvGet`/`kvSet` used e.g. by the embedding cache and the reaper
 * heartbeat). Previously these silently rode the BullMQ producer connection —
 * meaning a "fail open on Redis error" call site never actually failed fast,
 * it just inherited the producer's slow-to-fail buffering. This profile is the
 * fix: short `commandTimeout`, `enableOfflineQueue: false` so a command REJECTS
 * immediately during an outage instead of queueing silently, and a single retry
 * (`maxRetriesPerRequest: 1`) so a call site's own catch block actually runs
 * within a bounded time.
 */
export function applicationConnectionOptions(config: ConfigService): RedisOptions {
  return {
    ...baseOptions(config),
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectionName: 'app:kv',
  };
}

/**
 * RATE LIMITER (the tenant/campaign/API-key token-bucket Lua script). Same
 * fail-fast rationale as `application` — every caller of
 * `TenantRateLimiterService.consume()` has an explicit fail-open/fail-closed
 * branch that must actually run, not hang for the ~60-80s a buffered producer
 * connection would take to give up.
 */
export function rateLimiterConnectionOptions(config: ConfigService): RedisOptions {
  return {
    ...baseOptions(config),
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectionName: 'app:rate-limiter',
  };
}

/**
 * CACHE (AnalyticsCacheService's read-through cache). Previously built from the
 * deprecated `redisConnectionOptions` alias (i.e. the BLOCKING profile) with an
 * ad-hoc `maxRetriesPerRequest: 1` override — correct by accident, not by
 * design. This is the proper dedicated profile: fail-fast, no offline
 * buffering (a cache read/write should reject immediately and fall through to
 * the database, never queue).
 */
export function cacheConnectionOptions(config: ConfigService): RedisOptions {
  return {
    ...baseOptions(config),
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectionName: 'app:cache',
  };
}
