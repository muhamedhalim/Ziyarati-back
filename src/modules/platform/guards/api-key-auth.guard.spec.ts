import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeyService } from '../api-key.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { TenantRateLimiterService } from '../../../queue/tenant-rate-limiter.service';
import { ErrorCode } from '../../../common/errors';
import { createMockExecutionContext } from '../../../../test/utils/mock-factories';
import type { ApiLogService } from '../api-log.service';
import type { MetricsService } from '../../../metrics/metrics.service';
import { AppError } from '../../../common/errors';

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let apiKeys: { authenticate: jest.Mock };
  let ctx: { setPrincipal: jest.Mock };
  let rateLimiter: { consume: jest.Mock };
  let config: { get: jest.Mock };
  let apiLogs: { record: jest.Mock };
  let metrics: { recordApiKeyAuthFailure: jest.Mock };

  const AUTH = { keyId: 'k1', tenantId: 't1', permissions: ['integration.services.read'] };

  beforeEach(() => {
    apiKeys = { authenticate: jest.fn().mockResolvedValue(AUTH) };
    ctx = { setPrincipal: jest.fn() };
    rateLimiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
    config = { get: jest.fn().mockReturnValue(undefined) };
    apiLogs = { record: jest.fn().mockResolvedValue(undefined) };
    metrics = { recordApiKeyAuthFailure: jest.fn() };
    guard = makeGuard();
  });

  function makeGuard() {
    return new ApiKeyAuthGuard(
      apiKeys as unknown as ApiKeyService,
      ctx as unknown as TenantContextService,
      rateLimiter as unknown as TenantRateLimiterService,
      config as any,
      apiLogs as unknown as ApiLogService,
      metrics as unknown as MetricsService,
    );
  }

  function request(headers: Record<string, string> = {}) {
    const req: any = {
      header: (name: string) => headers[name.toLowerCase()],
    };
    return req;
  }

  it('extracts the key from X-API-Key and builds the synthetic principal', async () => {
    const req = request({ 'x-api-key': 'zk_abc' });
    const result = await guard.canActivate(createMockExecutionContext(req));
    expect(result).toBe(true);
    expect(apiKeys.authenticate).toHaveBeenCalledWith('zk_abc');
    expect(req.user).toEqual({
      id: 'apikey:k1',
      tenantId: 't1',
      email: null,
      roles: [],
      permissions: ['integration.services.read'],
    });
    expect(ctx.setPrincipal).toHaveBeenCalledWith(req.user);
  });

  it('extracts the key from the Authorization: ApiKey scheme', async () => {
    const req = request({ authorization: 'ApiKey zk_xyz' });
    await guard.canActivate(createMockExecutionContext(req));
    expect(apiKeys.authenticate).toHaveBeenCalledWith('zk_xyz');
  });

  it('propagates authenticate() rejection (invalid/expired/revoked/inactive key)', async () => {
    apiKeys.authenticate.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { code: ErrorCode.UNAUTHORIZED }),
    );
    await expect(
      guard.canActivate(createMockExecutionContext(request({ 'x-api-key': 'zk_bad' }))),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    expect(rateLimiter.consume).not.toHaveBeenCalled();
  });

  it('consumes the per-key rate-limit bucket, namespaced by keyId, before building the principal', async () => {
    await guard.canActivate(createMockExecutionContext(request({ 'x-api-key': 'zk_abc' })));
    expect(rateLimiter.consume).toHaveBeenCalledWith(
      't1',
      'apikey:k1',
      expect.objectContaining({ ratePerMinute: expect.any(Number) }),
    );
  });

  it('rejects with RATE_LIMITED when the bucket denies the request', async () => {
    rateLimiter.consume.mockResolvedValueOnce({ allowed: false, reason: 'RATE', retryAfterMs: 500 });
    await expect(
      guard.canActivate(createMockExecutionContext(request({ 'x-api-key': 'zk_abc' }))),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
  });

  it('fails OPEN (allows the request) when the rate limiter itself errors', async () => {
    rateLimiter.consume.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      guard.canActivate(createMockExecutionContext(request({ 'x-api-key': 'zk_abc' }))),
    ).resolves.toBe(true);
  });

  it('reads the configured per-minute limit from ConfigService', () => {
    config.get.mockReturnValue('42');
    const g = makeGuard();
    expect((g as unknown as { ratePerMinute: number }).ratePerMinute).toBe(42);
  });

  describe('SEC-06 — rejected keys are observable', () => {
    const rejection = (internalContext?: Record<string, unknown>) =>
      new AppError(ErrorCode.UNAUTHORIZED, { message: 'Invalid or inactive API key', internalContext });

    function requestWithRoute() {
      return {
        header: (name: string) => ({ 'x-api-key': 'zk_dead' })[name.toLowerCase()],
        method: 'GET',
        path: '/api/v1/integrations/customers',
        route: { path: '/integrations/customers' },
        ip: '203.0.113.7',
      } as any;
    }
    const tryOnce = (g: ApiKeyAuthGuard) =>
      g.canActivate(createMockExecutionContext(requestWithRoute())).catch((e) => e);

    it('logs a REVOKED/inactive key against ITS tenant as a 401 row, and still returns the same 401', async () => {
      apiKeys.authenticate.mockRejectedValueOnce(
        rejection({ reason: 'inactive', keyId: 'k-dead', tenantId: 't-owner' }),
      );
      const err = await tryOnce(guard);
      expect(err).toMatchObject({ code: ErrorCode.UNAUTHORIZED });
      expect(apiLogs.record).toHaveBeenCalledTimes(1);
      expect(apiLogs.record).toHaveBeenCalledWith('t-owner', {
        endpoint: '/integrations/customers',
        method: 'GET',
        statusCode: 401,
        ipAddress: '203.0.113.7',
        apiKeyId: 'k-dead',
      });
      expect(metrics.recordApiKeyAuthFailure).toHaveBeenCalledWith('inactive');
    });

    it('logs an EXPIRED key the same way', async () => {
      apiKeys.authenticate.mockRejectedValueOnce(
        rejection({ reason: 'expired', keyId: 'k-old', tenantId: 't-owner' }),
      );
      await tryOnce(guard);
      expect(apiLogs.record).toHaveBeenCalledWith('t-owner', expect.objectContaining({ apiKeyId: 'k-old', statusCode: 401 }));
      expect(metrics.recordApiKeyAuthFailure).toHaveBeenCalledWith('expired');
    });

    it('an UNKNOWN or missing key is counted only — there is no tenant, so nothing is written per request', async () => {
      apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'unknown' }));
      apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'missing' }));
      await tryOnce(guard);
      await tryOnce(guard);
      expect(apiLogs.record).not.toHaveBeenCalled();
      expect(metrics.recordApiKeyAuthFailure).toHaveBeenNthCalledWith(1, 'unknown');
      expect(metrics.recordApiKeyAuthFailure).toHaveBeenNthCalledWith(2, 'missing');
    });

    it('writes at most ONE row per key per minute, then again after the window', async () => {
      const now = jest.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000_000);
        for (let i = 0; i < 5; i++) {
          apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: 'k-dead', tenantId: 't-owner' }));
          await tryOnce(guard);
        }
        expect(apiLogs.record).toHaveBeenCalledTimes(1);
        expect(metrics.recordApiKeyAuthFailure).toHaveBeenCalledTimes(5); // every attempt is still COUNTED

        now.mockReturnValue(1_000_000 + 61_000);
        apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: 'k-dead', tenantId: 't-owner' }));
        await tryOnce(guard);
        expect(apiLogs.record).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('throttles per key: a different revoked key is still logged inside the same minute', async () => {
      apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: 'k-1', tenantId: 't-owner' }));
      apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: 'k-2', tenantId: 't-owner' }));
      await tryOnce(guard);
      await tryOnce(guard);
      expect(apiLogs.record).toHaveBeenCalledTimes(2);
    });

    it('a failing log WRITE can never change the response — the caller still gets the original 401', async () => {
      apiLogs.record.mockRejectedValue(new Error('db down'));
      apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: 'k-x', tenantId: 't-owner' }));
      await expect(tryOnce(guard)).resolves.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
      expect(apiLogs.record).toHaveBeenCalledTimes(1); // it WAS attempted
    });

    it('a broken METRIC can never change the response either', async () => {
      metrics.recordApiKeyAuthFailure.mockImplementation(() => {
        throw new Error('registry broken');
      });
      apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: 'k-y', tenantId: 't-owner' }));
      await expect(tryOnce(guard)).resolves.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('ignores non-authentication errors (no reason → nothing is counted or logged)', async () => {
      apiKeys.authenticate.mockRejectedValueOnce(new Error('connection reset'));
      await tryOnce(guard);
      expect(metrics.recordApiKeyAuthFailure).not.toHaveBeenCalled();
      expect(apiLogs.record).not.toHaveBeenCalled();
    });

    it('does not log a successful authentication', async () => {
      await guard.canActivate(createMockExecutionContext(request({ 'x-api-key': 'zk_abc' })));
      expect(apiLogs.record).not.toHaveBeenCalled();
      expect(metrics.recordApiKeyAuthFailure).not.toHaveBeenCalled();
    });

    it('bounds its memory: the throttle map is capped and never grows past the limit', async () => {
      for (let i = 0; i < 1_005; i++) {
        apiKeys.authenticate.mockRejectedValueOnce(rejection({ reason: 'inactive', keyId: `k-${i}`, tenantId: 't-owner' }));
        await tryOnce(guard);
      }
      const size = (guard as unknown as { lastRejectionLoggedAt: Map<string, number> }).lastRejectionLoggedAt.size;
      expect(size).toBeLessThanOrEqual(1_000);
    });
  });
});
