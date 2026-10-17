/**
 * T054 (015-db-api-efficiency-audit, P8) — proves `overview()`'s 10s shared
 * cache (T053, POLL-001/CACHE-008) behaves correctly under all four states a
 * read-through cache can be in: hit, miss, explicit bypass, and Redis down.
 *
 * Pure unit test — no database, no Redis. `AnalyticsCacheService` itself
 * (version-counter keys, single-flight lease, fail-open on any Redis error)
 * is already covered by `analytics-cache.service.spec.ts`; this file only
 * proves `MonitoringService` calls it correctly.
 */
import { MonitoringService } from './monitoring.service';

function build(
  options: {
    cached?: unknown;
    failOpen?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const dataSource = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('api_logs') && sql.includes('error_rate')) {
        return Promise.resolve([
          { last_hour: 3, today: 10, avg_ms: 42, error_rate: 0 },
        ]);
      }
      if (sql.includes('GROUP BY endpoint')) return Promise.resolve([]);
      if (sql.includes('GROUP BY status')) return Promise.resolve([]);
      if (sql.includes('MAX(created_at)')) {
        return Promise.resolve([
          { last_success: null, last_failure: null, total: 0 },
        ]);
      }
      if (sql.includes('tenant_verification_documents')) {
        return Promise.resolve([{ docs: 0, bytes: 0 }]);
      }
      return Promise.resolve([]);
    }),
  };

  const queues = {
    queueCounts: jest.fn().mockResolvedValue({}),
    redisPing: jest.fn().mockResolvedValue(2),
    kvGet: jest.fn().mockResolvedValue(null),
  };

  const config = {
    get: jest.fn((k: string) => options.env?.[k]),
  };
  const storage = { isConfigured: jest.fn().mockReturnValue(false) };

  const cacheCalls: { ns: string; suffix: string }[] = [];
  const cache = {
    wrap: <T>(
      _scope: string,
      ns: string,
      suffix: string,
      producer: () => Promise<T>,
    ) => {
      cacheCalls.push({ ns, suffix });
      // `failOpen` simulates the REAL AnalyticsCacheService's behavior when
      // Redis is unreachable: `wrap` always falls through to `producer()`,
      // regardless of any value that would otherwise be "cached".
      if (options.failOpen) return producer();
      return 'cached' in options
        ? Promise.resolve(options.cached as T)
        : producer();
    },
  };

  const service = new MonitoringService(
    {} as never, // ApiLog repo — unused directly, only via dataSource.query
    {} as never, // WebhookLog repo — unused directly, only via dataSource.query
    dataSource as never,
    queues as never,
    config as never,
    storage as never,
    cache as never,
  );

  return { service, dataSource, queues, cache, cacheCalls };
}

describe('MonitoringService — overview() caching', () => {
  it('a cache hit runs no aggregation at all', async () => {
    const cached = { system: {}, traffic: {}, collectedAt: 'cached-at' };
    const { service, dataSource, queues } = build({ cached });

    const result = await service.overview();

    expect(result).toEqual(cached);
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(queues.queueCounts).not.toHaveBeenCalled();
  });

  it('a miss reaches the database', async () => {
    const { service, dataSource, queues } = build();

    await service.overview();

    expect(dataSource.query).toHaveBeenCalled();
    expect(queues.queueCounts).toHaveBeenCalledTimes(1);
  });

  it('an explicit `Cache-Control: no-cache` bypasses the cache entirely', async () => {
    const cached = { system: {}, traffic: {}, collectedAt: 'cached-at' };
    const { service, dataSource, cacheCalls } = build({ cached });

    const result = await service.overview({ bypassCache: true });

    expect(cacheCalls).toHaveLength(0);
    expect(dataSource.query).toHaveBeenCalled();
    expect(result.collectedAt).not.toBe('cached-at');
  });

  it('Redis unavailable (fail-open) still reaches the database and returns a correct payload', async () => {
    const { service } = build({ failOpen: true });

    const result = await service.overview();

    expect(result.collectedAt).toEqual(expect.any(String));
    expect(result.system.database).toBeDefined();
    expect(result.traffic.requestsLastHour).toBe(3);
    expect(Array.isArray(result.alerts)).toBe(true);
  });

  it('the cached payload carries no tenant-specific data — it is platform-global', async () => {
    const { service } = build();

    const result = await service.overview();

    // Top-level shape is exactly the platform-wide sections `computeOverview`
    // produces — nothing tenant-scoped ever slips into the one shared entry.
    expect(Object.keys(result).sort()).toEqual(
      [
        'alerts',
        'collectedAt',
        'externalServices',
        'infrastructure',
        'queues',
        'source',
        'system',
        'traffic',
        'webhooks',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/tenantId/i);
  });

  it('caches under the dedicated PLATFORM namespace with a fixed scope, never a real tenant id', async () => {
    const { service, cacheCalls } = build();

    await service.overview();

    expect(cacheCalls).toEqual([{ ns: 'platform', suffix: 'overview' }]);
  });
});

describe('MonitoringService — AWS-aware provider status and data source', () => {
  const svc = (result: { externalServices: { name: string; status: string }[] }, name: string) =>
    result.externalServices.find((s) => s.name.startsWith(name));

  it('email is judged by the SES region alone — no API key is read', async () => {
    const { service } = build({ env: { AWS_REGION: 'eu-central-1' } });
    const result = await service.overview({ bypassCache: true });
    expect(svc(result, 'Email Provider')).toMatchObject({
      name: 'Email Provider (SES)',
      status: 'configured',
    });
  });

  it('email without an SES region is reported not_configured', async () => {
    const { service } = build();
    const result = await service.overview({ bypassCache: true });
    expect(svc(result, 'Email Provider')?.status).toBe('not_configured');
  });

  it('a leftover RESEND_API_KEY never makes email look configured', async () => {
    const result = await build({ env: { RESEND_API_KEY: 'x' } }).service.overview({
      bypassCache: true,
    });
    expect(svc(result, 'Email Provider')).toMatchObject({
      name: 'Email Provider (SES)',
      status: 'not_configured',
    });
  });

  it('SES_REGION alone is enough (credentials come from the task role)', async () => {
    const result = await build({ env: { SES_REGION: 'eu-central-1' } }).service.overview({
      bypassCache: true,
    });
    expect(svc(result, 'Email Provider')?.status).toBe('configured');
  });

  it('labels object storage as S3, not R2', async () => {
    const result = await build().service.overview({ bypassCache: true });
    expect(svc(result, 'Object Storage')?.name).toBe('Object Storage (S3)');
  });

  it('source exposes the Redis host only — never credentials, port or path', async () => {
    const { service } = build({
      env: {
        NODE_ENV: 'production',
        AWS_REGION: 'eu-central-1',
        REDIS_URL: 'rediss://default:s3cr3t@zt-prod.cache.amazonaws.com:6379/0',
      },
    });
    const { source } = await service.overview({ bypassCache: true });
    expect(source).toMatchObject({
      environment: 'production',
      awsRegion: 'eu-central-1',
      redisHost: 'zt-prod.cache.amazonaws.com',
      failedJobRetentionDays: 7,
    });
    expect(JSON.stringify(source)).not.toMatch(/s3cr3t|6379|default:/);
  });

  it('a malformed REDIS_URL yields a null host instead of throwing', async () => {
    const { service } = build({ env: { REDIS_URL: 'not a url' } });
    const { source } = await service.overview({ bypassCache: true });
    expect(source.redisHost).toBeNull();
  });
});
