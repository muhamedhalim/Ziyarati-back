import { TenantRateLimiterService } from './tenant-rate-limiter.service';
import { AppRedisService } from './app-redis.service';

describe('TenantRateLimiterService', () => {
  let service: TenantRateLimiterService;
  let evalMock: jest.Mock;
  let appRedis: {
    rateLimiter: { defineCommand: jest.Mock; rlConsume: jest.Mock };
  };

  const policy = { ratePerMinute: 60, dailyCap: 1000, monthlyCap: 10_000 };

  beforeEach(() => {
    evalMock = jest.fn();
    appRedis = {
      rateLimiter: { defineCommand: jest.fn(), rlConsume: evalMock },
    };
    service = new TenantRateLimiterService(
      appRedis as unknown as AppRedisService,
    );
  });

  it('registers rlConsume via defineCommand once, at construction (M16 — EVALSHA instead of EVAL per call)', () => {
    expect(appRedis.rateLimiter.defineCommand).toHaveBeenCalledWith(
      'rlConsume',
      expect.objectContaining({ numberOfKeys: 3, lua: expect.any(String) }),
    );
  });

  it('allows when the Lua script returns status 0', async () => {
    evalMock.mockResolvedValueOnce([0, 0]);
    await expect(service.consume('t1', 'c1', policy)).resolves.toEqual({
      allowed: true,
    });
  });

  it('maps status 1 to a transient RATE denial with the retry delay', async () => {
    evalMock.mockResolvedValueOnce([1, 800]);
    await expect(service.consume('t1', 'c1', policy)).resolves.toEqual({
      allowed: false,
      reason: 'RATE',
      retryAfterMs: 800,
    });
  });

  it('floors the RATE retry delay at 250ms', async () => {
    evalMock.mockResolvedValueOnce([1, 50]);
    const res = await service.consume('t1', 'c1', policy);
    expect(res).toEqual({ allowed: false, reason: 'RATE', retryAfterMs: 250 });
  });

  it('maps status 2 to a terminal DAILY_CAP denial', async () => {
    evalMock.mockResolvedValueOnce([2, 0]);
    await expect(service.consume('t1', 'c1', policy)).resolves.toEqual({
      allowed: false,
      reason: 'DAILY_CAP',
    });
  });

  it('maps status 3 to a terminal MONTHLY_CAP denial', async () => {
    evalMock.mockResolvedValueOnce([3, 0]);
    await expect(service.consume('t1', 'c1', policy)).resolves.toEqual({
      allowed: false,
      reason: 'MONTHLY_CAP',
    });
  });

  it('passes -1 caps to the script when daily/monthly caps are unset (unlimited)', async () => {
    evalMock.mockResolvedValueOnce([0, 0]);
    await service.consume('t1', 'c1', {
      ratePerMinute: 30,
      dailyCap: null,
      monthlyCap: null,
    });

    const args = evalMock.mock.calls[0];
    // KEYS=3 then ARGV: capacity, refill, now, dailyCap, monthlyCap, ...
    expect(args).toContain('-1'); // both caps serialized as '-1'
  });

  describe('environment-prefixed keys (M3)', () => {
    const ORIGINAL = process.env.QUEUE_ENV_PREFIX;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.QUEUE_ENV_PREFIX;
      else process.env.QUEUE_ENV_PREFIX = ORIGINAL;
    });

    it('uses unprefixed rl:* keys when QUEUE_ENV_PREFIX is unset', async () => {
      delete process.env.QUEUE_ENV_PREFIX;
      evalMock.mockResolvedValueOnce([0, 0]);
      await service.consume('t1', 'c1', policy);
      const [bucketKey, dailyKey, monthlyKey] = evalMock.mock.calls[0];
      expect(bucketKey).toBe('rl:bucket:t1:c1');
      expect(dailyKey).toMatch(/^rl:day:t1:/);
      expect(monthlyKey).toMatch(/^rl:month:t1:/);
    });

    it('prefixes every key with the configured environment when QUEUE_ENV_PREFIX is set', async () => {
      process.env.QUEUE_ENV_PREFIX = 'staging';
      evalMock.mockResolvedValueOnce([0, 0]);
      await service.consume('t1', 'c1', policy);
      const [bucketKey, dailyKey, monthlyKey] = evalMock.mock.calls[0];
      expect(bucketKey).toBe('staging:rl:bucket:t1:c1');
      expect(dailyKey).toMatch(/^staging:rl:day:t1:/);
      expect(monthlyKey).toMatch(/^staging:rl:month:t1:/);
    });
  });
});
