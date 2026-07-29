import { ConfigService } from '@nestjs/config';

import {
  producerConnectionOptions,
  blockingConnectionOptions,
  eventsConnectionOptions,
  applicationConnectionOptions,
  rateLimiterConnectionOptions,
  cacheConnectionOptions,
} from './redis.config';

const config = {
  get: (k: string) => (k === 'REDIS_URL' ? 'redis://localhost:6379' : undefined),
} as unknown as ConfigService;

/**
 * Locks in the Phase 0 fail-fast contract (see
 * docs/CACHING_QUEUES_AUDIT.md §0.2/§0.5): `commandTimeout` must be set on the
 * three "application" roles and absent from the three BullMQ roles. This is
 * the actual mechanism behind C2's fix — a config-level test that would catch
 * a future edit accidentally adding a timeout to a blocking connection (which
 * would race BullMQ's own lock-renewal timers) or removing one from an
 * application connection (silently reintroducing the ~60-80s hang).
 */
describe('redis.config — Phase 0 fail-fast contract', () => {
  describe('BullMQ roles — must NEVER have a commandTimeout', () => {
    it.each([
      ['producer', producerConnectionOptions],
      ['blocking (worker)', blockingConnectionOptions],
      ['events (QueueEvents)', eventsConnectionOptions],
    ])('%s', (_label, fn) => {
      const opts = fn(config);
      expect(opts.commandTimeout).toBeUndefined();
    });

    it('blocking and events profiles set maxRetriesPerRequest: null (mandatory for BullMQ blocking commands)', () => {
      expect(blockingConnectionOptions(config).maxRetriesPerRequest).toBeNull();
      expect(eventsConnectionOptions(config).maxRetriesPerRequest).toBeNull();
    });

    it('producer keeps the offline queue enabled (buffers enqueues across a brief blip)', () => {
      expect(producerConnectionOptions(config).enableOfflineQueue).toBe(true);
    });
  });

  describe('application roles — must ALWAYS have a short commandTimeout + no offline queue', () => {
    it.each([
      ['application (kv/health-check)', applicationConnectionOptions],
      ['rateLimiter', rateLimiterConnectionOptions],
      ['cache', cacheConnectionOptions],
    ])('%s', (_label, fn) => {
      const opts = fn(config);
      expect(opts.commandTimeout).toBe(2000);
      expect(opts.enableOfflineQueue).toBe(false);
      expect(opts.maxRetriesPerRequest).toBe(1);
    });
  });

  it('every profile carries a distinct connectionName for CLIENT LIST observability', () => {
    const names = [
      producerConnectionOptions(config).connectionName,
      blockingConnectionOptions(config).connectionName,
      eventsConnectionOptions(config).connectionName,
      applicationConnectionOptions(config).connectionName,
      rateLimiterConnectionOptions(config).connectionName,
      cacheConnectionOptions(config).connectionName,
    ];
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length); // all distinct
  });

  it('throws when REDIS_URL is unset (the queue subsystem cannot boot without it)', () => {
    const empty = { get: () => undefined } as unknown as ConfigService;
    expect(() => applicationConnectionOptions(empty)).toThrow(/REDIS_URL is required/);
  });
});
