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
 */
export function producerConnectionOptions(config: ConfigService): RedisOptions {
  return { ...baseOptions(config), enableOfflineQueue: true };
}

/**
 * BLOCKING connection (Workers + QueueEvents). BullMQ mandates
 * `maxRetriesPerRequest: null` here — its blocking commands must never be
 * aborted mid-wait.
 */
export function blockingConnectionOptions(config: ConfigService): RedisOptions {
  // `maxRetriesPerRequest: null` is mandatory for BullMQ blocking roles. Offline
  // queue is left enabled because this profile is also the shared default the
  // API producers use — buffering their enqueues across brief blips.
  return {
    ...baseOptions(config),
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  };
}

/**
 * QUEUEEVENTS connection (the monitor's pub/sub listener). Like the blocking
 * profile it needs `maxRetriesPerRequest: null`, but it is read-only (never
 * enqueues) so the offline queue is disabled. A distinct instance keeps the
 * monitor's blocking `XREAD`/subscribe loop off the producer and worker sockets.
 */
export function eventsConnectionOptions(config: ConfigService): RedisOptions {
  return {
    ...baseOptions(config),
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  };
}

/**
 * @deprecated Back-compat alias kept for existing imports. Returns the blocking
 * profile (the previous behaviour). Prefer the role-specific helpers above.
 */
export function redisConnectionOptions(config: ConfigService): RedisOptions {
  return blockingConnectionOptions(config);
}
