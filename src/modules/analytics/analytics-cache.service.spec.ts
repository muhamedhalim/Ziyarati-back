class FakeRedis {
  static instances: FakeRedis[] = [];
  handlers = new Map<string, (...args: unknown[]) => void>();
  store = new Map<string, string>();
  ttls = new Map<string, number>();

  constructor(public readonly opts: Record<string, unknown>) {
    FakeRedis.instances.push(this);
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  connect() {
    return Promise.resolve();
  }
  quit() {
    return Promise.resolve('OK');
  }
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async set(
    key: string,
    value: string,
    ...args: unknown[]
  ): Promise<string | null> {
    // Emulate NX: reject if the key already exists and NX was requested.
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async incr(key: string): Promise<number> {
    const next = (Number(this.store.get(key)) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }
  async expire(key: string, ttlSeconds: number): Promise<number> {
    if (!this.store.has(key)) return 0;
    this.ttls.set(key, ttlSeconds);
    return 1;
  }
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<number> {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

jest.mock('ioredis', () => ({ Redis: FakeRedis }));

import { AnalyticsCacheService, CACHE_NS } from './analytics-cache.service';
import { ConfigService } from '@nestjs/config';

function buildConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: unknown) => values[key] ?? def,
  } as unknown as ConfigService;
}

describe('AnalyticsCacheService — single-flight lease on miss (M4)', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const build = () => {
    const config = buildConfig({ REDIS_URL: 'redis://localhost:6379' });
    const service = new AnalyticsCacheService(config);
    const redis = FakeRedis.instances[0];
    return { service, redis };
  };

  it('computes once and caches the result on a cold miss', async () => {
    const { service } = build();
    const producer = jest.fn().mockResolvedValue({ total: 42 });

    const result = await service.wrap(
      't1',
      CACHE_NS.DASHBOARD,
      'suffix',
      producer,
    );

    expect(result).toEqual({ total: 42 });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('serves the cached value on a subsequent call without recomputing', async () => {
    const { service } = build();
    const producer = jest.fn().mockResolvedValue({ total: 1 });

    await service.wrap('t1', CACHE_NS.DASHBOARD, 'suffix', producer);
    const second = await service.wrap(
      't1',
      CACHE_NS.DASHBOARD,
      'suffix',
      producer,
    );

    expect(second).toEqual({ total: 1 });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent misses for the same key: only the lease winner computes, the loser gets the winner's value", async () => {
    const { service, redis } = build();
    let computeCount = 0;
    const producer = jest.fn().mockImplementation(async () => {
      computeCount += 1;
      // Simulate a slow aggregation query so the "loser" call genuinely
      // arrives while the winner is still computing.
      await new Promise((r) => setTimeout(r, 50));
      return { total: computeCount };
    });

    const [a, b] = await Promise.all([
      service.wrap('t1', CACHE_NS.DASHBOARD, 'concurrent', producer),
      service.wrap('t1', CACHE_NS.DASHBOARD, 'concurrent', producer),
    ]);

    expect(computeCount).toBe(1); // only the lease winner actually computed
    expect(a).toEqual(b); // the loser got the winner's result, not its own
    expect(redis.store.size).toBeGreaterThan(0); // value key is cached
  });

  it('releases the lease after computing, so a later expiry-driven miss is not blocked by a stale lease', async () => {
    const { service, redis } = build();
    await service.wrap('t1', CACHE_NS.DASHBOARD, 'suffix', async () => ({
      v: 1,
    }));

    const leaseKeys = Array.from(redis.store.keys()).filter((k) =>
      k.endsWith(':lease'),
    );
    expect(leaseKeys).toHaveLength(0); // released, not left dangling
  });

  it('falls through to computing directly if the lease-acquire itself errors (fail-open)', async () => {
    const { service, redis } = build();
    jest.spyOn(redis, 'set').mockRejectedValueOnce(new Error('redis down'));
    const producer = jest.fn().mockResolvedValue({ ok: true });

    const result = await service.wrap(
      't1',
      CACHE_NS.DASHBOARD,
      'suffix',
      producer,
    );

    expect(result).toEqual({ ok: true });
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('is a no-op passthrough when Redis is unconfigured — computes directly, no lease dance', async () => {
    const config = buildConfig({}); // no REDIS_URL
    const service = new AnalyticsCacheService(config);
    const producer = jest.fn().mockResolvedValue({ ok: true });

    const result = await service.wrap(
      't1',
      CACHE_NS.DASHBOARD,
      'suffix',
      producer,
    );

    expect(result).toEqual({ ok: true });
    expect(producer).toHaveBeenCalledTimes(1);
  });
});

describe('AnalyticsCacheService.invalidate — version-key TTL (M17)', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const build = () => {
    const config = buildConfig({ REDIS_URL: 'redis://localhost:6379' });
    const service = new AnalyticsCacheService(config);
    const redis = FakeRedis.instances[0];
    return { service, redis };
  };

  it('gives the version key a TTL after bumping it, so it can never outlive an evicted-and-orphaned value key window', async () => {
    const { service, redis } = build();
    await service.invalidate('t1', CACHE_NS.DASHBOARD);

    const versionKey = Array.from(redis.store.keys()).find((k) =>
      k.endsWith(':ver'),
    );
    expect(versionKey).toBeDefined();
    expect(redis.ttls.get(versionKey!)).toBe(30 * 24 * 3600);
  });

  it('does not throw if the TTL refresh itself fails — the INCR already succeeded (fail-open)', async () => {
    const { service, redis } = build();
    jest.spyOn(redis, 'expire').mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.invalidate('t1', CACHE_NS.DASHBOARD),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when Redis is unconfigured', async () => {
    const config = buildConfig({});
    const service = new AnalyticsCacheService(config);
    await expect(
      service.invalidate('t1', CACHE_NS.DASHBOARD),
    ).resolves.toBeUndefined();
  });
});

describe('AnalyticsCacheService — tenant isolation on cache keys (§18 test-plan #8)', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const build = () => {
    const config = buildConfig({ REDIS_URL: 'redis://localhost:6379' });
    const service = new AnalyticsCacheService(config);
    const redis = FakeRedis.instances[0];
    return { service, redis };
  };

  it("tenant A's value key and tenant B's value key for the identical (ns, suffix) never collide", async () => {
    const { service, redis } = build();
    await service.wrap('tenant-a', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'A-data',
    }));
    await service.wrap('tenant-b', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'B-data',
    }));

    const keys = Array.from(redis.store.keys()).filter((k) =>
      k.includes(':dashboard:'),
    );
    const tenantAKeys = keys.filter((k) => k.includes(':tenant-a:'));
    const tenantBKeys = keys.filter((k) => k.includes(':tenant-b:'));
    expect(tenantAKeys).not.toHaveLength(0);
    expect(tenantBKeys).not.toHaveLength(0);
    // No key string is shared between the two tenants' key sets.
    expect(tenantAKeys.some((k) => tenantBKeys.includes(k))).toBe(false);
  });

  it("tenant B's read path never returns tenant A's cached payload for the same (ns, suffix)", async () => {
    const { service } = build();
    await service.wrap('tenant-a', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'A-secret',
    }));

    const producerB = jest.fn().mockResolvedValue({ value: 'B-data' });
    const resultB = await service.wrap(
      'tenant-b',
      CACHE_NS.DASHBOARD,
      'kpis',
      producerB,
    );

    // Tenant B gets a genuine miss (its own producer runs) — tenant A's
    // cached value under the same ns/suffix is structurally unreadable via
    // tenant B's key.
    expect(producerB).toHaveBeenCalledTimes(1);
    expect(resultB).toEqual({ value: 'B-data' });
  });

  it("invalidating tenant A's namespace does not bump tenant B's version counter or affect tenant B's cached value", async () => {
    const { service, redis } = build();
    await service.wrap('tenant-a', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'A-data',
    }));
    await service.wrap('tenant-b', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'B-data',
    }));

    await service.invalidate('tenant-a', CACHE_NS.DASHBOARD);

    const producerB = jest.fn().mockResolvedValue({ value: 'B-data-v2' });
    const resultB = await service.wrap(
      'tenant-b',
      CACHE_NS.DASHBOARD,
      'kpis',
      producerB,
    );
    // Tenant B's own cache entry is untouched by tenant A's invalidation —
    // still a hit against the ORIGINAL cached value, producer not re-run.
    expect(producerB).not.toHaveBeenCalled();
    expect(resultB).toEqual({ value: 'B-data' });
    expect(
      redis.store.get('analytics:tenant:tenant-b:dashboard:ver'),
    ).toBeUndefined();
  });
});

describe('AnalyticsCacheService — version-bump invalidation guarantee, and its real boundary (§18 test-plan #7/#11)', () => {
  beforeEach(() => {
    FakeRedis.instances = [];
  });

  const build = () => {
    const config = buildConfig({ REDIS_URL: 'redis://localhost:6379' });
    const service = new AnalyticsCacheService(config);
    const redis = FakeRedis.instances[0];
    return { service, redis };
  };

  it('the NORMAL invalidation path (INCR via invalidate()) always orphans the old value — a subsequent read recomputes, never sees the stale payload', async () => {
    const { service } = build();
    await service.wrap('t1', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'v1',
    }));
    await service.invalidate('t1', CACHE_NS.DASHBOARD);

    const producer = jest.fn().mockResolvedValue({ value: 'v2' });
    const result = await service.wrap(
      't1',
      CACHE_NS.DASHBOARD,
      'kpis',
      producer,
    );

    expect(producer).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: 'v2' });
  });

  it('documents the real (narrow, operationally-mitigated) boundary of the design: a RAW deletion of the version key — not a normal invalidate() — while an old value key still lives, DOES resurrect stale data', async () => {
    // This is intentionally not "no stale value ever served" — that stronger
    // claim is not what the current design guarantees at the code level. The
    // version counter falls back to '0' when its key is absent (see
    // `version()`), so if something deletes ONLY the version key (a manual
    // `DEL`, or an eviction that should be impossible under this codebase's
    // own noeviction+maxmemory boot enforcement — see C1) while a `v0` value
    // key from an earlier low-version era is still alive, a reader
    // reconstructs the SAME v0 key and gets the old data back. This is
    // exactly the scenario `VERSION_KEY_TTL_SECONDS` (30 days, far longer
    // than any value key's ~60s TTL) is defense-in-depth against
    // OPERATIONALLY, not a structural impossibility — recorded here as an
    // honest characterization, not a false "fixed" claim.
    const { service, redis } = build();
    await service.wrap('t1', CACHE_NS.DASHBOARD, 'kpis', async () => ({
      value: 'stale-v0-data',
    }));

    const versionKey = Array.from(redis.store.keys()).find((k) =>
      k.endsWith(':ver'),
    )!;
    redis.store.delete(versionKey); // simulate the version key vanishing

    const producer = jest
      .fn()
      .mockResolvedValue({ value: 'should-not-see-this' });
    const result = await service.wrap(
      't1',
      CACHE_NS.DASHBOARD,
      'kpis',
      producer,
    );

    expect(producer).not.toHaveBeenCalled();
    expect(result).toEqual({ value: 'stale-v0-data' });
  });
});
