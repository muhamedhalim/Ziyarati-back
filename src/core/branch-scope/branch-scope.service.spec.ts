import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BranchScopeService } from './branch-scope.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { AppRedisService } from '../../queue/app-redis.service';
import { ErrorCode } from '../../common/errors';
import { PERMISSION, ROLE, ROLE_PERMISSIONS } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

/** A principal shaped like the one `JwtStrategy` puts on the request. */
const principal = (permissions: string[]) => ({ id: USER, permissions });

const BRANCH_MANAGER = ROLE_PERMISSIONS[ROLE.BRANCH_MANAGER] as string[];
const OWNER = ROLE_PERMISSIONS[ROLE.OWNER] as string[];
const RECEPTIONIST = ROLE_PERMISSIONS[ROLE.RECEPTIONIST] as string[];
const DOCTOR = ROLE_PERMISSIONS[ROLE.DOCTOR] as string[];

describe('BranchScopeService', () => {
  let service: BranchScopeService;
  let context: TenantContextService;
  let branchUsers: MockRepository;
  let redis: { application: { get: jest.Mock; set: jest.Mock } };

  beforeEach(async () => {
    branchUsers = createMockRepository();
    redis = {
      application: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      },
    };
    context = new TenantContextService();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BranchScopeService,
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
        { provide: AppRedisService, useValue: redis },
        { provide: TenantContextService, useValue: context },
      ],
    }).compile();
    service = moduleRef.get(BranchScopeService);
  });

  afterEach(() => jest.clearAllMocks());

  const assignedTo = (...ids: string[]) =>
    branchUsers.find.mockResolvedValue(ids.map((id) => ({ branch: { id } })));

  // ── The rule ─────────────────────────────────────────────────────────────

  describe('resolve — who gets narrowed', () => {
    it('narrows a branch_manager to their assigned branches', async () => {
      assignedTo(BRANCH_A);
      const scope = await service.resolve(TENANT, principal(BRANCH_MANAGER));
      expect(scope.branchIds).toEqual([BRANCH_A]);
    });

    /**
     * The backward-compatibility guarantee, asserted against the REAL grant
     * lists rather than hand-written ones: if a future edit ever makes one of
     * these roles branch-restricted, that role silently stops seeing its own
     * clinic — and this fails first.
     */
    it.each([
      ['owner', OWNER],
      ['receptionist', RECEPTIONIST],
      ['doctor', DOCTOR],
      ['manager', ROLE_PERMISSIONS[ROLE.MANAGER] as string[]],
    ])(
      'leaves %s tenant-wide even when they ARE assigned to a branch',
      async (_name, permissions) => {
        assignedTo(BRANCH_A);
        const scope = await service.resolve(TENANT, principal(permissions));
        expect(scope.branchIds).toBeNull();
        // Not merely "unrestricted" — the membership query is never even run
        // for a tenant-wide caller, so this adds no per-request cost.
        expect(branchUsers.find).not.toHaveBeenCalled();
      },
    );

    it('treats a null principal (worker job, patient self-service) as tenant-wide', async () => {
      const scope = await service.resolve(TENANT, null);
      expect(scope.branchIds).toBeNull();
    });

    it('narrows an arbitrary custom role granted branches.update_own', async () => {
      assignedTo(BRANCH_B);
      const scope = await service.resolve(
        TENANT,
        principal([
          PERMISSION.DASHBOARD_ACCESS,
          PERMISSION.APPOINTMENTS_READ,
          PERMISSION.BRANCHES_UPDATE_OWN,
        ]),
      );
      expect(scope.branchIds).toEqual([BRANCH_B]);
    });

    /**
     * Fail-closed. A restricted account nobody assigned a branch to sees
     * nothing — never "fall back to the whole clinic", which is the
     * catastrophic reading of an empty membership list.
     */
    it('returns an EMPTY scope (not tenant-wide) for a restricted caller assigned to no branch', async () => {
      assignedTo();
      const scope = await service.resolve(TENANT, principal(BRANCH_MANAGER));
      expect(scope.branchIds).toEqual([]);
      expect(service.isAllowed(scope, BRANCH_A)).toBe(false);
    });
  });

  // ── Determinism + caching ────────────────────────────────────────────────

  it('returns branch ids in a stable (sorted) order, so downstream cache keys match', async () => {
    assignedTo(BRANCH_B, BRANCH_A);
    const scope = await service.resolve(TENANT, principal(BRANCH_MANAGER));
    expect(scope.branchIds).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('caches membership under a TENANT-qualified key, so a second call skips the database', async () => {
    assignedTo(BRANCH_A);
    await service.getMembershipBranchIds(TENANT, USER);

    expect(redis.application.set).toHaveBeenCalledWith(
      `branch-membership:${TENANT}:${USER}`,
      JSON.stringify([BRANCH_A]),
      'EX',
      expect.any(Number),
    );

    redis.application.get.mockResolvedValueOnce(JSON.stringify([BRANCH_A]));
    branchUsers.find.mockClear();
    const second = await service.getMembershipBranchIds(TENANT, USER);
    expect(second).toEqual([BRANCH_A]);
    expect(branchUsers.find).not.toHaveBeenCalled();
  });

  it('falls through to the database when Redis errors — a cache hiccup is never a 500', async () => {
    redis.application.get.mockRejectedValueOnce(new Error('down'));
    redis.application.set.mockRejectedValueOnce(new Error('down'));
    assignedTo(BRANCH_A);
    await expect(service.getMembershipBranchIds(TENANT, USER)).resolves.toEqual(
      [BRANCH_A],
    );
  });

  it('falls through to the database on a corrupt cache entry', async () => {
    redis.application.get.mockResolvedValueOnce('not json');
    assignedTo(BRANCH_A);
    await expect(service.getMembershipBranchIds(TENANT, USER)).resolves.toEqual(
      [BRANCH_A],
    );
  });

  // ── The boundary helpers ─────────────────────────────────────────────────

  describe('assertBranchAllowed', () => {
    it('permits any branch for a tenant-wide scope', () => {
      expect(() =>
        service.assertBranchAllowed({ branchIds: null }, BRANCH_B),
      ).not.toThrow();
    });

    it('permits an assigned branch', () => {
      expect(() =>
        service.assertBranchAllowed({ branchIds: [BRANCH_A] }, BRANCH_A),
      ).not.toThrow();
    });

    it('refuses a branch outside the scope with PERMISSION_DENIED', () => {
      expect(() =>
        service.assertBranchAllowed({ branchIds: [BRANCH_A] }, BRANCH_B),
      ).toThrow(expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }));
    });

    it('refuses a missing branch id for a restricted caller', () => {
      expect(() =>
        service.assertBranchAllowed({ branchIds: [BRANCH_A] }, undefined),
      ).toThrow(expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }));
    });
  });

  describe('branchFilter', () => {
    it('is undefined for a tenant-wide scope, so no WHERE clause is added at all', () => {
      expect(service.branchFilter({ branchIds: null })).toBeUndefined();
    });

    it('produces an IN filter for a restricted scope', () => {
      const filter = service.branchFilter({ branchIds: [BRANCH_A, BRANCH_B] });
      expect(filter).toBeDefined();
      expect(filter!.id).toMatchObject({ _value: [BRANCH_A, BRANCH_B] });
    });

    it('produces an IN filter matching nothing for an empty scope', () => {
      const filter = service.branchFilter({ branchIds: [] });
      expect(filter!.id).toMatchObject({ _value: [] });
    });
  });

  // ── The ambient variant ──────────────────────────────────────────────────

  describe('resolveCurrent — the ambient principal', () => {
    it('reads the request-scoped principal published by TenantContextInterceptor', async () => {
      assignedTo(BRANCH_A);
      await context.run(async () => {
        context.setPrincipal({
          id: USER,
          tenantId: TENANT,
          roles: [ROLE.BRANCH_MANAGER],
          permissions: BRANCH_MANAGER,
        });
        const scope = await service.resolveCurrent(TENANT);
        expect(scope.branchIds).toEqual([BRANCH_A]);
      });
    });

    it('is tenant-wide outside a request (a worker job has no principal)', async () => {
      const scope = await service.resolveCurrent(TENANT);
      expect(scope.branchIds).toBeNull();
    });
  });
});
