import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { ApiKeyService } from '../api-key.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { TenantRateLimiterService } from '../../../queue/tenant-rate-limiter.service';
import { ErrorCode } from '../../../common/errors';
import { createMockExecutionContext } from '../../../../test/utils/mock-factories';

describe('ApiKeyAuthGuard', () => {
  let guard: ApiKeyAuthGuard;
  let apiKeys: { authenticate: jest.Mock };
  let ctx: { setPrincipal: jest.Mock };
  let rateLimiter: { consume: jest.Mock };
  let config: { get: jest.Mock };

  const AUTH = { keyId: 'k1', tenantId: 't1', permissions: ['integration.services.read'] };

  beforeEach(() => {
    apiKeys = { authenticate: jest.fn().mockResolvedValue(AUTH) };
    ctx = { setPrincipal: jest.fn() };
    rateLimiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
    config = { get: jest.fn().mockReturnValue(undefined) };
    guard = new ApiKeyAuthGuard(
      apiKeys as unknown as ApiKeyService,
      ctx as unknown as TenantContextService,
      rateLimiter as unknown as TenantRateLimiterService,
      config as any,
    );
  });

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
    const g = new ApiKeyAuthGuard(
      apiKeys as unknown as ApiKeyService,
      ctx as unknown as TenantContextService,
      rateLimiter as unknown as TenantRateLimiterService,
      config as any,
    );
    expect((g as unknown as { ratePerMinute: number }).ratePerMinute).toBe(42);
  });
});
