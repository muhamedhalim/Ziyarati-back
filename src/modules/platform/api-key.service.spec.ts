import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ApiKeyService, ApiKeyActor } from './api-key.service';
import { ApiKeyAuditService, API_KEY_AUDIT_ACTION } from './api-key-audit.service';
import { ApiKey } from '../../entities/System/ApiKey';
import { ErrorCode } from '../../common/errors';
import { INTEGRATION_SCOPE } from './integration-scopes.constants';
import { PERMISSION } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

const SUPER_ACTOR: ApiKeyActor = { userId: 'u1', permissions: [], isSuperAdmin: true };
const OWNER_ACTOR_FULL: ApiKeyActor = {
  userId: 'u1',
  isSuperAdmin: false,
  permissions: [
    PERMISSION.SERVICES_READ,
    PERMISSION.STAFF_READ,
    PERMISSION.SCHEDULING_AVAILABILITY_READ,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.APPOINTMENTS_READ,
  ],
};

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let keys: MockRepository;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    keys = createMockRepository();
    // P5-2 (015-db-api-efficiency-audit, AUTH-006): `authenticate` now reads
    // the tenant FK column via entity metadata (R-11 — ApiKey exposes no
    // plain `tenantId` property), the same `.metadata.findRelationWithPropertyPath`
    // pattern `DashboardSummaryService.fk()` already uses. `tenantId` matches
    // the real column name (BaselineSchema migration: `api_keys."tenantId"`).
    (keys as unknown as { metadata: unknown }).metadata = {
      name: 'ApiKey',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyService,
        { provide: getRepositoryToken(ApiKey), useValue: keys },
        { provide: ApiKeyAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(ApiKeyService);
  });

  /**
   * Wires `keys.createQueryBuilder()` to return `getRawAndEntities()` shaped
   * like `authenticate`'s real query — one entity plus the raw `tenant_fk`
   * column — for exactly the next call. `tenantFk` mirrors what
   * `key.tenant?.id` used to be: the tenant's id string, or `null` for a
   * platform key.
   */
  function mockAuthenticateQuery(
    entity: Record<string, unknown> | null,
    tenantFk: string | null = null,
  ) {
    const qb = createMockQueryBuilder();
    qb.getRawAndEntities = jest.fn(async () => ({
      entities: entity ? [entity] : [],
      raw: entity ? [{ tenant_fk: tenantFk }] : [],
    }));
    keys.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  afterEach(() => jest.clearAllMocks());

  it('creates a key, returns the plaintext once, and never leaks the hash', async () => {
    keys.save.mockResolvedValueOnce({
      id: 'k1',
      key_hash: 'secret-hash',
      key_prefix: 'zk_abc',
      name: 'n',
      permissions: [],
      is_active: true,
    });
    const res = await service.create(TENANT, { name: 'n', permissions: [] } as any, SUPER_ACTOR);
    expect(res.apiKey).toEqual(expect.any(String));
    expect(res.apiKey.length).toBeGreaterThan(0);
    expect((res as Record<string, unknown>).key_hash).toBeUndefined();
  });

  it('stores a safe key_prefix derived from the plaintext', async () => {
    keys.save.mockImplementationOnce(async (k: any) => k);
    const res = await service.create(TENANT, { permissions: [] } as any, SUPER_ACTOR);
    expect(res.key_prefix).toBeDefined();
    expect(res.apiKey.startsWith(res.key_prefix!)).toBe(true);
  });

  it('rejects a scope the caller does not themselves hold the underlying permission for', async () => {
    const actor: ApiKeyActor = { userId: 'u1', isSuperAdmin: false, permissions: [] };
    await expect(
      service.create(TENANT, { permissions: [INTEGRATION_SCOPE.SERVICES_READ] } as any, actor),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect(keys.save).not.toHaveBeenCalled();
  });

  it('allows a scope the caller holds the underlying permission for', async () => {
    keys.save.mockImplementationOnce(async (k: any) => k);
    await expect(
      service.create(
        TENANT,
        { permissions: [INTEGRATION_SCOPE.SERVICES_READ] } as any,
        OWNER_ACTOR_FULL,
      ),
    ).resolves.toMatchObject({ permissions: [INTEGRATION_SCOPE.SERVICES_READ] });
  });

  it('super_admin may grant any scope regardless of held permissions', async () => {
    keys.save.mockImplementationOnce(async (k: any) => k);
    await expect(
      service.create(
        TENANT,
        { permissions: [INTEGRATION_SCOPE.APPOINTMENTS_READ] } as any,
        SUPER_ACTOR,
      ),
    ).resolves.toMatchObject({ permissions: [INTEGRATION_SCOPE.APPOINTMENTS_READ] });
  });

  it('records an audit row on create', async () => {
    keys.save.mockImplementationOnce(async (k: any) => ({ ...k, id: 'k1' }));
    await service.create(TENANT, { name: 'n', permissions: [] } as any, SUPER_ACTOR);
    expect(audit.record).toHaveBeenCalledWith(
      API_KEY_AUDIT_ACTION.CREATE,
      TENANT,
      'u1',
      'k1',
      undefined,
      expect.objectContaining({ name: 'n' }),
    );
  });

  it('rotate issues a fresh secret + prefix for an existing key and audits it', async () => {
    keys.findOne.mockResolvedValueOnce({ id: 'k1', key_hash: 'old', key_prefix: 'zk_old' });
    keys.save.mockImplementationOnce(async (k: any) => k);
    const res = await service.rotate(TENANT, 'k1', { ...SUPER_ACTOR, ip: '1.2.3.4' });
    expect(res.apiKey).toEqual(expect.any(String));
    expect(res.key_prefix).not.toBe('zk_old');
    expect(audit.record).toHaveBeenCalledWith(API_KEY_AUDIT_ACTION.ROTATE, TENANT, 'u1', 'k1', '1.2.3.4');
  });

  it('revoke deactivates, immediately expires the key, and audits it', async () => {
    keys.findOne.mockResolvedValueOnce({ id: 'k1', is_active: true });
    keys.save.mockImplementationOnce(async (k: any) => k);
    await service.revoke(TENANT, 'k1', { userId: 'u1' });
    const saved = keys.save.mock.calls[0][0];
    expect(saved.is_active).toBe(false);
    expect(saved.expires_at).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledWith(API_KEY_AUDIT_ACTION.REVOKE, TENANT, 'u1', 'k1', undefined);
  });

  it('activate / deactivate toggle is_active and audit each transition', async () => {
    keys.findOne.mockResolvedValue({ id: 'k1', is_active: false });
    keys.save.mockImplementation(async (k: any) => k);
    expect((await service.activate(TENANT, 'k1', SUPER_ACTOR)).is_active).toBe(true);
    expect((await service.deactivate(TENANT, 'k1', { userId: 'u1' })).is_active).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(API_KEY_AUDIT_ACTION.ACTIVATE, TENANT, 'u1', 'k1', undefined);
    expect(audit.record).toHaveBeenCalledWith(API_KEY_AUDIT_ACTION.DEACTIVATE, TENANT, 'u1', 'k1', undefined);
  });

  describe('SEC-04 — expiry must be in the future', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    it('refuses a key created already expired, and writes nothing', async () => {
      await expect(
        service.create(TENANT, { permissions: [], expiresAt: past } as any, SUPER_ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(keys.save).not.toHaveBeenCalled();
    });

    it('refuses an unparseable expiry', async () => {
      await expect(
        service.create(TENANT, { permissions: [], expiresAt: 'soon' } as any, SUPER_ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('accepts a future expiry and stores it', async () => {
      keys.save.mockImplementationOnce(async (k: any) => k);
      await service.create(TENANT, { permissions: [], expiresAt: future } as any, SUPER_ACTOR);
      expect(keys.save.mock.calls[0][0].expires_at).toEqual(new Date(future));
    });

    it('applies to platform keys too', async () => {
      await expect(
        service.createPlatformKey(
          { permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY], expiresAt: past },
          { userId: 'u1', isSuperAdmin: true },
        ),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });
  });

  describe('SEC-03 — rotate/activate re-check the ACTING user against the key\'s scopes', () => {
    const writeKey = (overrides: Record<string, unknown> = {}) => ({
      id: 'k1',
      key_hash: 'old',
      key_prefix: 'zk_old',
      is_active: false,
      permissions: [INTEGRATION_SCOPE.SERVICES_WRITE],
      expires_at: null,
      ...overrides,
    });
    const noWriteActor: ApiKeyActor = {
      userId: 'demoted',
      isSuperAdmin: false,
      permissions: [PERMISSION.SERVICES_READ],
    };
    const writeActor: ApiKeyActor = {
      userId: 'owner',
      isSuperAdmin: false,
      permissions: [PERMISSION.SERVICES_CREATE],
    };

    it('rotate is refused for an actor who lacks a scope\'s underlying permission, and nothing is saved', async () => {
      keys.findOne.mockResolvedValueOnce(writeKey({ is_active: true }));
      await expect(service.rotate(TENANT, 'k1', noWriteActor)).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
      expect(keys.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rotate succeeds for an actor who holds it, and for a super-admin', async () => {
      keys.save.mockImplementation(async (k: any) => k);
      keys.findOne.mockResolvedValueOnce(writeKey({ is_active: true }));
      await expect(service.rotate(TENANT, 'k1', writeActor)).resolves.toMatchObject({ apiKey: expect.any(String) });
      keys.findOne.mockResolvedValueOnce(writeKey({ is_active: true }));
      await expect(service.rotate(TENANT, 'k1', SUPER_ACTOR)).resolves.toBeDefined();
    });

    it('activate is refused for an actor who lacks the underlying permission', async () => {
      keys.findOne.mockResolvedValueOnce(writeKey());
      await expect(service.activate(TENANT, 'k1', noWriteActor)).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
      expect(keys.save).not.toHaveBeenCalled();
    });

    it('activate succeeds for an actor who holds it', async () => {
      keys.save.mockImplementation(async (k: any) => k);
      keys.findOne.mockResolvedValueOnce(writeKey());
      await expect(service.activate(TENANT, 'k1', writeActor)).resolves.toMatchObject({ is_active: true });
    });

    it('a key with no scopes can be rotated by anyone who may manage keys', async () => {
      keys.save.mockImplementation(async (k: any) => k);
      keys.findOne.mockResolvedValueOnce(writeKey({ permissions: [] }));
      await expect(service.rotate(TENANT, 'k1', noWriteActor)).resolves.toBeDefined();
    });

    it('LEAST privilege can always be applied: deactivate and revoke need no scope check', async () => {
      keys.save.mockImplementation(async (k: any) => k);
      keys.findOne.mockResolvedValue(writeKey({ is_active: true }));
      await expect(service.deactivate(TENANT, 'k1', noWriteActor)).resolves.toMatchObject({ is_active: false });
      await expect(service.revoke(TENANT, 'k1', noWriteActor)).resolves.toMatchObject({ is_active: false });
    });

    it('rotate and activate refuse an expired/revoked key with a clear 422', async () => {
      const expired = writeKey({ is_active: false, expires_at: new Date(Date.now() - 1000) });
      keys.findOne.mockResolvedValue(expired);
      await expect(service.rotate(TENANT, 'k1', SUPER_ACTOR)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        message: expect.stringContaining('cannot be rotated'),
      });
      await expect(service.activate(TENANT, 'k1', SUPER_ACTOR)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        message: expect.stringContaining('cannot be activated'),
      });
      expect(keys.save).not.toHaveBeenCalled();
    });

    it('a key whose expiry is still in the future can be rotated', async () => {
      keys.save.mockImplementation(async (k: any) => k);
      keys.findOne.mockResolvedValueOnce(writeKey({ is_active: true, expires_at: new Date(Date.now() + 86_400_000) }));
      await expect(service.rotate(TENANT, 'k1', SUPER_ACTOR)).resolves.toBeDefined();
    });
  });

  describe('describeOwn (GET /integrations/me)', () => {
    it('returns the caller\'s own key, scoped by id AND tenant, with no hash and no tenant id', async () => {
      keys.findOne.mockResolvedValueOnce({
        id: 'k1',
        key_hash: 'SECRET-HASH',
        key_prefix: 'zk_abc',
        name: 'ERP',
        permissions: [INTEGRATION_SCOPE.SERVICES_READ, 'junk.scope'],
        expires_at: new Date('2030-01-01T00:00:00Z'),
        last_used_at: null,
        tenant: { id: TENANT },
      });
      const me = await service.describeOwn(TENANT, 'k1');
      expect(keys.findOne.mock.calls[0][0].where).toEqual({ id: 'k1', tenant: { id: TENANT } });
      expect(me).toEqual({
        keyId: 'k1',
        keyPrefix: 'zk_abc',
        name: 'ERP',
        scopes: [INTEGRATION_SCOPE.SERVICES_READ],
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        lastUsedAt: null,
      });
      expect(JSON.stringify(me)).not.toContain('SECRET-HASH');
      expect(JSON.stringify(me)).not.toContain(TENANT);
    });

    it('404s when the key is not in that tenant', async () => {
      keys.findOne.mockResolvedValueOnce(null);
      await expect(service.describeOwn(TENANT, 'k1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  it('findOneOrThrow (via get) throws for an unknown key', async () => {
    keys.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('list() strips legacy/junk scope strings from stored permissions', async () => {
    keys.findAndCount.mockResolvedValueOnce([
      [{ id: 'k1', permissions: ['services.read', INTEGRATION_SCOPE.SERVICES_READ, 123, null] }],
      1,
    ]);
    const res = await service.list(TENANT, { page: 1, limit: 20 } as any);
    expect(res.data[0].permissions).toEqual([INTEGRATION_SCOPE.SERVICES_READ]);
  });

  describe('authenticate', () => {
    it('rejects a missing key', async () => {
      await expect(service.authenticate(undefined)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('rejects an unknown or inactive key', async () => {
      mockAuthenticateQuery(null);
      await expect(service.authenticate('plain')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

      mockAuthenticateQuery({ id: 'k1', is_active: false }, TENANT);
      await expect(service.authenticate('plain')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('rejects an expired key', async () => {
      mockAuthenticateQuery(
        { id: 'k1', is_active: true, expires_at: new Date(Date.now() - 1000) },
        TENANT,
      );
      await expect(service.authenticate('plain')).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('F09 — missing, unknown, revoked and expired keys carry the SAME public message', async () => {
      const messages: string[] = [];
      const capture = async () => {
        const e = (await service.authenticate('plain').catch((x) => x)) as { message: string };
        messages.push(e.message);
      };
      mockAuthenticateQuery(null);
      await capture(); // unknown
      mockAuthenticateQuery({ id: 'k1', is_active: false }, TENANT);
      await capture(); // revoked / deactivated
      mockAuthenticateQuery({ id: 'k2', is_active: true, expires_at: new Date(Date.now() - 1000) }, TENANT);
      await capture(); // expired
      const missing = (await service.authenticate(undefined).catch((x) => x)) as { message: string };
      messages.push(missing.message);
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('Invalid or inactive API key');
    });

    it('SEC-06 — tells the guard WHICH key was refused and why, without changing the public 401', async () => {
      await expect(service.authenticate(undefined)).rejects.toMatchObject({
        internalContext: { reason: 'missing' },
      });

      mockAuthenticateQuery(null);
      await expect(service.authenticate('plain')).rejects.toMatchObject({
        internalContext: { reason: 'unknown' }, // no key row → no key id / tenant to leak or log
      });

      mockAuthenticateQuery({ id: 'k1', is_active: false }, TENANT);
      await expect(service.authenticate('plain')).rejects.toMatchObject({
        internalContext: { reason: 'inactive', keyId: 'k1', tenantId: TENANT },
      });

      mockAuthenticateQuery(
        { id: 'k2', is_active: true, expires_at: new Date(Date.now() - 1000) },
        TENANT,
      );
      await expect(service.authenticate('plain')).rejects.toMatchObject({
        internalContext: { reason: 'expired', keyId: 'k2', tenantId: TENANT },
      });
    });

    it('SEC-06 — the diagnostic context is never part of the client-visible error', async () => {
      mockAuthenticateQuery({ id: 'k1', is_active: false }, TENANT);
      const err = (await service.authenticate('plain').catch((e) => e)) as {
        publicContext?: unknown;
      };
      // Only `publicContext` is serialised into the response (see AllExceptionsFilter).
      expect(err.publicContext).toBeUndefined();
    });

    it('resolves the principal for a valid key, normalizing legacy scope junk', async () => {
      mockAuthenticateQuery(
        {
          id: 'k1',
          is_active: true,
          expires_at: null,
          permissions: [INTEGRATION_SCOPE.CUSTOMERS_READ, 'not-a-real-scope'],
          last_used_at: null,
        },
        TENANT,
      );
      const principal = await service.authenticate('plain');
      expect(principal).toEqual({
        keyId: 'k1',
        tenantId: TENANT,
        permissions: [INTEGRATION_SCOPE.CUSTOMERS_READ],
      });
    });

    // P5-2 (AUTH-006) — the regression this fix could introduce: a
    // null/undefined tenantId silently granting platform (unscoped) access
    // to what should be a tenant-scoped key.
    it('resolves tenantId: null ONLY for a genuine platform key, never as a fallback', async () => {
      mockAuthenticateQuery(
        {
          id: 'k-platform',
          is_active: true,
          expires_at: null,
          permissions: [],
          last_used_at: null,
        },
        null, // no tenant row — a real platform-level key
      );
      const principal = await service.authenticate('plain');
      expect(principal.tenantId).toBeNull();
    });

    it('resolves the exact tenant FK for a tenant-scoped key — a wrong/dropped value would be a cross-tenant leak', async () => {
      mockAuthenticateQuery(
        { id: 'k-tenant', is_active: true, expires_at: null, permissions: [], last_used_at: null },
        'tenant-42',
      );
      const principal = await service.authenticate('plain');
      expect(principal.tenantId).toBe('tenant-42');
    });

    it('issues exactly one query (createQueryBuilder, not findOne)', async () => {
      const qb = mockAuthenticateQuery(
        { id: 'k1', is_active: true, expires_at: null, permissions: [], last_used_at: null },
        TENANT,
      );
      await service.authenticate('plain');
      expect(keys.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(keys.findOne).not.toHaveBeenCalled();
      expect(qb.getRawAndEntities).toHaveBeenCalledTimes(1);
    });

    it('the throttled last_used_at update still fires and cannot fail the request', async () => {
      mockAuthenticateQuery(
        { id: 'k1', is_active: true, expires_at: null, permissions: [], last_used_at: null },
        TENANT,
      );
      keys.update.mockRejectedValueOnce(new Error('db hiccup'));
      await expect(service.authenticate('plain')).resolves.toMatchObject({ keyId: 'k1' });
      expect(keys.update).toHaveBeenCalledWith({ id: 'k1' }, { last_used_at: expect.any(Date) });
    });
  });

  describe('createPlatformKey (contract C11)', () => {
    it('refuses a non-super-admin caller', async () => {
      await expect(
        service.createPlatformKey(
          { permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY] },
          { userId: 'u1', isSuperAdmin: false },
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(keys.save).not.toHaveBeenCalled();
    });

    it('refuses a tenant-scoped permission on a platform key', async () => {
      await expect(
        service.createPlatformKey(
          { permissions: [INTEGRATION_SCOPE.SERVICES_READ] },
          { userId: 'u1', isSuperAdmin: true },
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(keys.save).not.toHaveBeenCalled();
    });

    it('creates a key with tenant omitted (NULL join column) for a super-admin caller', async () => {
      keys.save.mockImplementationOnce(async (k: any) => ({ ...k, id: 'plat-1' }));

      const res = await service.createPlatformKey(
        { name: 'Marketplace', permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY] },
        { userId: 'super-1', isSuperAdmin: true },
      );

      expect(res.apiKey).toEqual(expect.any(String));
      expect((res as Record<string, unknown>).key_hash).toBeUndefined();
      const createdEntity = keys.save.mock.calls[0][0];
      expect(createdEntity.tenant).toBeUndefined();
      expect(createdEntity.permissions).toEqual([INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY]);
    });

    it("records the audit entry with a null tenant, never the caller's own tenant", async () => {
      keys.save.mockImplementationOnce(async (k: any) => ({ ...k, id: 'plat-1' }));

      await service.createPlatformKey(
        { permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY] },
        { userId: 'super-1', isSuperAdmin: true },
      );

      expect(audit.record).toHaveBeenCalledWith(
        API_KEY_AUDIT_ACTION.CREATE,
        null,
        'super-1',
        'plat-1',
        undefined,
        expect.objectContaining({ platformLevel: true }),
      );
    });
  });
});
