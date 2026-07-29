import { TenantRateLimiterService } from './tenant-rate-limiter.service';
import { AppRedisService } from './app-redis.service';

describe('TenantRateLimiterService', () => {
  let service: TenantRateLimiterService;
  let evalMock: jest.Mock;
  let appRedis: { rateLimiter: { eval: jest.Mock } };

  const policy = { ratePerMinute: 60, dailyCap: 1000, monthlyCap: 10_000 };

  beforeEach(() => {
    evalMock = jest.fn();
    appRedis = { rateLimiter: { eval: evalMock } };
    service = new TenantRateLimiterService(appRedis as unknown as AppRedisService);
  });

  it('allows when the Lua script returns status 0', async () => {
    evalMock.mockResolvedValueOnce([0, 0]);
    await expect(service.consume('t1', 'c1', policy)).resolves.toEqual({ allowed: true });
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
    await service.consume('t1', 'c1', { ratePerMinute: 30, dailyCap: null, monthlyCap: null });

    const args = evalMock.mock.calls[0];
    // KEYS=3 then ARGV: capacity, refill, now, dailyCap, monthlyCap, ...
    expect(args).toContain('-1'); // both caps serialized as '-1'
  });
});
