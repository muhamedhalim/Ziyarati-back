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
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ (its blocking commands must
 * not be aborted), and the capped retry strategy keeps producers/consumers
 * reconnecting across deploys and failovers instead of dying.
 */
export function redisConnectionOptions(config: ConfigService): RedisOptions {
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
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  };
  if (isTls) {
    options.tls = {};
  }
  return options;
}
