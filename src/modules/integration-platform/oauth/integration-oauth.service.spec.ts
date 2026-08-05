import { IntegrationOAuthService } from './integration-oauth.service';
import { CONNECTION_STATUS } from '../integration-platform.constants';
import {
  __resetTestOAuthAdapter,
  resolveOAuthAdapter,
  TEST_PROVIDER_KEY,
} from './oauth.registry';
import { generateCodeVerifier } from './oauth.types';

/**
 * Covers the H11 fix (docs/CACHING_QUEUES_AUDIT.md): `refresh()` now runs
 * under a real distributed lock (ownership token + renewal) instead of a
 * rate-limiter-as-mutex with no ownership and a no-op release. The primitive
 * itself (`SET NX PX` acquire, compare-and-delete release, compare-and-PEXPIRE
 * renew) is already unit-tested in `distributed-lock.service.spec.ts`; this
 * spec only proves `IntegrationOAuthService.refresh()` uses it correctly —
 * acquire → renew-while-running → release, and the fallback path when the
 * lock is held by someone else.
 */

function repoMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
    ...over,
  } as any;
}

const encryption = {
  encrypt: jest.fn((v: string) => `ENC:${v}`),
  decrypt: jest.fn((v: string) => String(v).replace('ENC:', '')),
} as any;
const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;

function lockMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    acquire: jest.fn().mockResolvedValue('token-1'),
    release: jest.fn().mockResolvedValue(undefined),
    renew: jest.fn().mockResolvedValue(true),
    ...over,
  } as any;
}

function build(connections: any, locks: any, states: any = repoMock()) {
  return new IntegrationOAuthService(
    states,
    connections,
    encryption,
    audit,
    locks,
  );
}

const tenantId = 't1';
const connectionId = 'c1';
const actor = { userId: 'u1' };

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: connectionId,
    tenant: { id: tenantId },
    provider: TEST_PROVIDER_KEY,
    status: CONNECTION_STATUS.ACTIVE,
    oauth_access_token_ciphertext: 'ENC:old-access',
    oauth_refresh_token_ciphertext: 'ENC:test-refresh-live',
    // Already expired, so `refresh()` always attempts a real refresh.
    oauth_expires_at: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

describe('IntegrationOAuthService.refresh — distributed lock (H11)', () => {
  const originalEnv = process.env.INTEGRATION_OAUTH_TEST_PROVIDER;

  beforeEach(() => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = 'true';
    __resetTestOAuthAdapter();
    jest.clearAllMocks();
    encryption.encrypt.mockImplementation((v: string) => `ENC:${v}`);
    encryption.decrypt.mockImplementation((v: string) =>
      String(v).replace('ENC:', ''),
    );
  });

  afterEach(() => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = originalEnv;
    __resetTestOAuthAdapter();
    jest.useRealTimers();
  });

  /** Seeds a live test-adapter refresh token by performing a real exchange first. */
  async function seedLiveRefreshToken(): Promise<string> {
    const adapter = resolveOAuthAdapter(TEST_PROVIDER_KEY)!;
    const tokens = await adapter.exchangeCode({
      code: 'good-code',
      codeVerifier: generateCodeVerifier(),
      redirectUri: 'http://localhost:3000/cb',
    });
    return tokens.refreshToken as string;
  }

  it('acquires the lock, refreshes, and releases with the SAME token', async () => {
    const liveRefresh = await seedLiveRefreshToken();
    const connection = baseConnection({
      oauth_refresh_token_ciphertext: `ENC:${liveRefresh}`,
    });
    const connections = repoMock({
      findOne: jest.fn().mockResolvedValue(connection),
      findOneOrFail: jest.fn().mockResolvedValue(connection),
    });
    const locks = lockMock({ acquire: jest.fn().mockResolvedValue('tok-abc') });
    const svc = build(connections, locks);

    const result = await svc.refresh(tenantId, connectionId, actor);

    expect(result.accessToken).toBeTruthy();
    expect(locks.acquire).toHaveBeenCalledTimes(1);
    expect(locks.acquire).toHaveBeenCalledWith(
      `oauth:refresh:${tenantId}:${connectionId}`,
      expect.any(Number),
    );
    expect(locks.release).toHaveBeenCalledTimes(1);
    expect(locks.release).toHaveBeenCalledWith(
      `oauth:refresh:${tenantId}:${connectionId}`,
      'tok-abc',
    );
  });

  it('falls back to the stored token when the lock is already held (no fabricated success)', async () => {
    const connection = baseConnection();
    const connections = repoMock({
      findOne: jest.fn().mockResolvedValue(connection),
      findOneOrFail: jest.fn().mockResolvedValue(connection),
    });
    const locks = lockMock({ acquire: jest.fn().mockResolvedValue(null) });
    const svc = build(connections, locks);

    const result = await svc.refresh(tenantId, connectionId, actor);

    expect(result.accessToken).toBe('old-access');
    // Never proceeded to touch the provider or release a lock it never held.
    expect(locks.release).not.toHaveBeenCalled();
  });

  it('throws SERVICE_UNAVAILABLE when the lock is held AND no token is available yet', async () => {
    const connection = baseConnection({ oauth_access_token_ciphertext: null });
    const connections = repoMock({
      findOne: jest.fn().mockResolvedValue(connection),
      findOneOrFail: jest.fn().mockResolvedValue(connection),
    });
    const locks = lockMock({ acquire: jest.fn().mockResolvedValue(null) });
    const svc = build(connections, locks);

    await expect(
      svc.refresh(tenantId, connectionId, actor),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('renews the lock while the refresh is still running, using the SAME token', async () => {
    jest.useFakeTimers();
    const liveRefresh = await seedLiveRefreshToken();
    const connection = baseConnection({
      oauth_refresh_token_ciphertext: `ENC:${liveRefresh}`,
    });
    const connections = repoMock({
      findOne: jest.fn().mockResolvedValue(connection),
      findOneOrFail: jest.fn().mockResolvedValue(connection),
    });

    // Simulate a slow provider call: renewal must fire before it resolves.
    let resolveRefresh!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const adapter = resolveOAuthAdapter(TEST_PROVIDER_KEY)!;
    const realRefresh = adapter.refresh.bind(adapter);
    jest.spyOn(adapter, 'refresh').mockImplementation(async (...args) => {
      await slow;
      return realRefresh(...args);
    });

    const locks = lockMock({
      acquire: jest.fn().mockResolvedValue('tok-renew'),
    });
    const svc = build(connections, locks);

    const pending = svc.refresh(tenantId, connectionId, actor);

    // Advance past half the lock TTL (15s) so the renewal interval fires.
    await jest.advanceTimersByTimeAsync(16_000);
    expect(locks.renew).toHaveBeenCalledWith(
      `oauth:refresh:${tenantId}:${connectionId}`,
      'tok-renew',
      expect.any(Number),
    );

    resolveRefresh();
    await pending;

    expect(locks.release).toHaveBeenCalledWith(
      `oauth:refresh:${tenantId}:${connectionId}`,
      'tok-renew',
    );
  });

  it('releases the lock even when the provider call throws a non-invalid_grant error', async () => {
    const connection = baseConnection();
    const connections = repoMock({
      findOne: jest.fn().mockResolvedValue(connection),
      findOneOrFail: jest.fn().mockResolvedValue(connection),
    });
    const adapter = resolveOAuthAdapter(TEST_PROVIDER_KEY)!;
    jest.spyOn(adapter, 'refresh').mockRejectedValue(new Error('network blip'));

    const locks = lockMock({ acquire: jest.fn().mockResolvedValue('tok-err') });
    const svc = build(connections, locks);

    await expect(svc.refresh(tenantId, connectionId, actor)).rejects.toThrow(
      'network blip',
    );
    expect(locks.release).toHaveBeenCalledWith(
      `oauth:refresh:${tenantId}:${connectionId}`,
      'tok-err',
    );
  });
});

// GAP-003 — `status()` (the controller's `GET :connectionId/status`) is the
// canonical OAuth "status" endpoint; `tokenView()` is its private mapper.
// Regression guard proving it stays presence/scope/expiry-only, never a token
// value — the sibling gap (the connections "detail"/list endpoint's
// `toSafe()`) was the one actually broken; this locks the endpoint that was
// already correct so it cannot silently regress.
describe('IntegrationOAuthService.status — token non-exposure (GAP-003)', () => {
  it('never returns the access or refresh token value, ciphertext or plaintext, only presence/scope/expiry', async () => {
    const connection = baseConnection({
      oauth_access_token_ciphertext: 'ENC:super-secret-access-token',
      oauth_refresh_token_ciphertext: 'ENC:super-secret-refresh-token',
      oauth_scope: 'read write',
    });
    const connections = repoMock({ findOne: jest.fn().mockResolvedValue(connection) });
    const svc = build(connections, lockMock());

    const result = await svc.status(tenantId, connectionId);

    expect(result).not.toHaveProperty('oauth_access_token_ciphertext');
    expect(result).not.toHaveProperty('oauth_refresh_token_ciphertext');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(result).toEqual({
      connectionId,
      provider: TEST_PROVIDER_KEY,
      connected: true,
      hasRefreshToken: true,
      expiresAt: connection.oauth_expires_at,
      expired: true,
      scope: 'read write',
      connectedAt: null,
      refreshedAt: null,
    });
  });
});
