import { ExecutionContext } from '@nestjs/common';
import { MarketplaceThrottlerGuard } from './marketplace-throttler.guard';
import { PublicDiscoveryController } from '../../modules/public-discovery/public-discovery.controller';
import { PublicBookingController } from '../../modules/public-booking/public-booking.controller';
import { INTEGRATION_SCOPE } from '../../modules/platform/integration-scopes.constants';

/**
 * Contract C11 — the guard's ONLY job is choosing a tracker string. Every
 * test below calls the protected `getTracker` directly (cast to `any`), the
 * same technique the base `ThrottlerGuard` test suite would use, since the
 * real trigger (`canActivate`) is base-class plumbing this class does not
 * override.
 */

class FakeDiscoveryController {}
Object.defineProperty(FakeDiscoveryController, 'name', { value: 'FakeController' });

function buildGuard(apiKeys: { authenticate: jest.Mock }) {
  const guard = new MarketplaceThrottlerGuard(
    { throttlers: [{ ttl: 60_000, limit: 30 }] } as never,
    { increment: jest.fn() } as never,
    { getAllAndOverride: jest.fn() } as never,
    apiKeys as never,
  );
  return guard;
}

function fakeContext(controllerClass: unknown): ExecutionContext {
  return {
    getClass: () => controllerClass,
    getHandler: () => function handler() {},
  } as unknown as ExecutionContext;
}

function fakeReq(headers: Record<string, string | undefined>): any {
  return {
    ip: '203.0.113.5',
    header: (name: string) => headers[name.toLowerCase()],
  };
}

const VALID_VISITOR = 'a'.repeat(32); // matches VISITOR_ID_RE

describe('MarketplaceThrottlerGuard (contract C11)', () => {
  it('falls back to req.ip when the route is not PublicDiscoveryController', async () => {
    const apiKeys = { authenticate: jest.fn() };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_whatever', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(FakeDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('falls back to req.ip when no API key is presented', async () => {
    const apiKeys = { authenticate: jest.fn() };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('falls back to req.ip when no visitor id header is presented', async () => {
    const apiKeys = { authenticate: jest.fn() };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_whatever' });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('falls back to req.ip when the visitor id is malformed', async () => {
    const apiKeys = { authenticate: jest.fn() };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_whatever', 'x-zt-visitor-id': 'not-a-hash' });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('falls back to req.ip when the key fails to authenticate', async () => {
    const apiKeys = { authenticate: jest.fn().mockRejectedValue(new Error('invalid key')) };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_bad', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
  });

  it('falls back to req.ip when the key is TENANT-scoped, not platform-level', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: 'tenant-1',
        permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
      }),
    };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_tenant', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
  });

  it('falls back to req.ip when the platform key lacks the marketplace:discovery scope', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: null,
        permissions: ['integration.services.read'],
      }),
    };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_platform', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toBe('203.0.113.5');
  });

  it('elevates to a per-visitor tracker when every condition holds', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: null,
        permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
      }),
    };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_platform', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toMatch(/^mkt:k1:[a-f0-9]{32}$/);
    expect(tracker).not.toBe('203.0.113.5');
  });

  it('gives two distinct visitor ids two distinct, independent trackers', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: null,
        permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
      }),
    };
    const guard = buildGuard(apiKeys);
    const reqA = fakeReq({ 'x-api-key': 'zk_platform', 'x-zt-visitor-id': 'a'.repeat(32) });
    const reqB = fakeReq({ 'x-api-key': 'zk_platform', 'x-zt-visitor-id': 'b'.repeat(32) });

    const trackerA = await (guard as any).getTracker(reqA, fakeContext(PublicDiscoveryController));
    const trackerB = await (guard as any).getTracker(reqB, fakeContext(PublicDiscoveryController));

    expect(trackerA).not.toBe(trackerB);
  });

  it('never leaks the raw visitor id into the tracker string', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: null,
        permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
      }),
    };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_platform', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).not.toContain(VALID_VISITOR);
  });

  it('never elevates PublicBookingController, even with fully valid credentials (booking is never elevated)', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: null,
        permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
      }),
    };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ 'x-api-key': 'zk_platform', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicBookingController));

    expect(tracker).toBe('203.0.113.5');
    expect(apiKeys.authenticate).not.toHaveBeenCalled();
  });

  it('accepts the key via Authorization: ApiKey as well as X-API-Key', async () => {
    const apiKeys = {
      authenticate: jest.fn().mockResolvedValue({
        keyId: 'k1',
        tenantId: null,
        permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY],
      }),
    };
    const guard = buildGuard(apiKeys);
    const req = fakeReq({ authorization: 'ApiKey zk_platform', 'x-zt-visitor-id': VALID_VISITOR });

    const tracker = await (guard as any).getTracker(req, fakeContext(PublicDiscoveryController));

    expect(tracker).toMatch(/^mkt:k1:/);
    expect(apiKeys.authenticate).toHaveBeenCalledWith('zk_platform');
  });
});
