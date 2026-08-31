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
    const res = await service.rotate(TENANT, 'k1', { userId: 'u1', ip: '1.2.3.4' });
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
    expect((await service.activate(TENANT, 'k1', { userId: 'u1' })).is_active).toBe(true);
    expect((await service.deactivate(TENANT, 'k1', { userId: 'u1' })).is_active).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(API_KEY_AUDIT_ACTION.ACTIVATE, TENANT, 'u1', 'k1', undefined);
    expect(audit.record).toHaveBeenCalledWith(API_KEY_AUDIT_ACTION.DEACTIVATE, TENANT, 'u1', 'k1', undefined);
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
});
