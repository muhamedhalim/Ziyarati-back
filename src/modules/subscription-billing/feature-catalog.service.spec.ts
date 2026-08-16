import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FeatureCatalogService } from './feature-catalog.service';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureResolverService } from './feature-resolver.service';
import { AccessCacheService } from './access-cache.service';
import { FeatureKey } from './feature-registry';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import {
  FeatureFlag,
  FeatureFlagSource,
} from '../../entities/SaaS-Core/FeatureFlag';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureDependency } from '../../entities/SaaS-Core/FeatureDependency';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { ErrorCode } from '../../common/errors';
import {
  createMockAccessCache,
  createMockDataSource,
  createMockEntityManager,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ACTOR = { id: 'admin-1', ip: '10.0.0.1' };

/**
 * Administrative SUSPENSION — the operator's kill-switch.
 *
 * `AccessControlService` has honoured `feature_flags.is_suspended` as
 * precedence rule 1 (above FREE mode and above a paid plan) since the policy
 * was centralized, and `FeatureFlagService.setSuspension` could write it — but
 * NOTHING could call that method. The rule was enforced and the switch was
 * unreachable. This covers the route that makes it operable, and the four
 * properties it has to have: reachable, justified, durably recorded, immediate.
 */
describe('FeatureCatalogService — tenant feature suspension', () => {
  let service: FeatureCatalogService;
  let flags: MockRepository;
  let tenants: MockRepository;
  let featureFlags: {
    setSuspension: jest.Mock;
    isEnabled: jest.Mock;
    set: jest.Mock;
    getStates: jest.Mock;
  };
  let accessCache: ReturnType<typeof createMockAccessCache>;
  let auditRepo: MockRepository;
  let dataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(async () => {
    flags = createMockRepository();
    tenants = createMockRepository();
    tenants.exists.mockResolvedValue(true);
    auditRepo = createMockRepository();

    const manager = createMockEntityManager(
      new Map<unknown, MockRepository>([[AuditLog, auditRepo]]),
    );
    dataSource = createMockDataSource(manager);

    featureFlags = {
      setSuspension: jest.fn(async () => ({
        feature_key: FeatureKey.WHATSAPP,
        is_suspended: true,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      })),
      isEnabled: jest.fn().mockResolvedValue(false),
      set: jest.fn(),
      getStates: jest.fn().mockResolvedValue(new Map()),
    };
    accessCache = createMockAccessCache();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureCatalogService,
        {
          provide: getRepositoryToken(FeatureDefinition),
          useValue: createMockRepository(),
        },
        { provide: getRepositoryToken(FeatureFlag), useValue: flags },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: createMockRepository(),
        },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        {
          provide: getRepositoryToken(FeaturePlan),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(FeatureDependency),
          useValue: createMockRepository(),
        },
        { provide: FeatureFlagService, useValue: featureFlags },
        {
          provide: FeatureResolverService,
          useValue: { resolveTenant: jest.fn(), dependenciesOf: jest.fn() },
        },
        { provide: AccessCacheService, useValue: accessCache },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(FeatureCatalogService);
  });

  afterEach(() => jest.clearAllMocks());

  it('suspends a capability with a reason and an actor', async () => {
    await service.setTenantFeatureSuspension(
      TENANT,
      FeatureKey.WHATSAPP,
      true,
      'Abuse report #4821',
      ACTOR,
    );

    expect(featureFlags.setSuspension).toHaveBeenCalledWith(
      TENANT,
      FeatureKey.WHATSAPP,
      true,
      expect.objectContaining({
        actorId: ACTOR.id,
        reason: 'Abuse report #4821',
      }),
    );
  });

  it('requires a reason to suspend', async () => {
    await expect(
      service.setTenantFeatureSuspension(
        TENANT,
        FeatureKey.WHATSAPP,
        true,
        '   ',
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(featureFlags.setSuspension).not.toHaveBeenCalled();
  });

  it('does NOT require a reason to lift a suspension', async () => {
    await expect(
      service.setTenantFeatureSuspension(
        TENANT,
        FeatureKey.WHATSAPP,
        false,
        undefined,
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  /**
   * Billing, support and the workspace shell are exempt from gating by design —
   * a blocked clinic must still be able to pay and ask for help — so the policy
   * would silently ignore a suspension there. Refusing loudly beats accepting a
   * control that does nothing.
   */
  it.each([FeatureKey.BILLING, FeatureKey.SUPPORT, FeatureKey.CORE_WORKSPACE])(
    'refuses to suspend the always-on capability "%s"',
    async (key) => {
      await expect(
        service.setTenantFeatureSuspension(TENANT, key, true, 'because', ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(featureFlags.setSuspension).not.toHaveBeenCalled();
    },
  );

  it('refuses a key that is not a real capability', async () => {
    await expect(
      service.setTenantFeatureSuspension(
        TENANT,
        'not.a.feature',
        true,
        'x',
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('records the previous value alongside the new one', async () => {
    flags.findOne.mockResolvedValueOnce({
      is_suspended: false,
      suspended_reason: null,
    });

    await service.setTenantFeatureSuspension(
      TENANT,
      FeatureKey.WHATSAPP,
      true,
      'Abuse report #4821',
      ACTOR,
    );

    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FEATURE_FLAG_SUSPEND',
        entity_type: 'feature_flag',
        entity_id: TENANT,
        ip_address: ACTOR.ip,
        old_values: expect.objectContaining({ suspended: false }),
        new_values: expect.objectContaining({
          suspended: true,
          reason: 'Abuse report #4821',
        }),
      }),
    );
  });

  /**
   * Unlike every other catalog write, the audit here is NOT best-effort: the
   * flag write and the audit row share one transaction. An entitlement
   * kill-switch with no record of who threw it and why is worse than no
   * kill-switch at all.
   */
  it('rolls the suspension back if the audit write fails', async () => {
    auditRepo.save.mockRejectedValueOnce(new Error('audit table down'));

    await expect(
      service.setTenantFeatureSuspension(
        TENANT,
        FeatureKey.WHATSAPP,
        true,
        'Abuse report #4821',
        ACTOR,
      ),
    ).rejects.toThrow('audit table down');
  });

  it('busts the tenant cache after the commit so the switch binds immediately', async () => {
    await service.setTenantFeatureSuspension(
      TENANT,
      FeatureKey.WHATSAPP,
      true,
      'Abuse report #4821',
      ACTOR,
    );

    expect(accessCache.invalidate).toHaveBeenCalledWith(TENANT);
  });

  it('refuses an unknown tenant before writing anything', async () => {
    tenants.exists.mockResolvedValueOnce(false);

    await expect(
      service.setTenantFeatureSuspension(
        TENANT,
        FeatureKey.WHATSAPP,
        true,
        'x',
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.TENANT_NOT_FOUND });
    expect(featureFlags.setSuspension).not.toHaveBeenCalled();
  });

  /**
   * The three-way control the console drives.
   *
   * It composes the two boolean primitives rather than reimplementing either,
   * and it exists so a transition BETWEEN states is atomic: run as two
   * requests, `suspended → granted` leaves a window in which the capability is
   * neither suspended nor granted, and every route for it answers
   * NO_ACTIVE_SUBSCRIPTION to a clinic the operator is mid-way through enabling.
   */
  describe('setTenantFeatureState', () => {
    it('writes an authoritative grant for `granted`', async () => {
      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.BRANCHES,
        'granted',
        undefined,
        ACTOR,
      );

      expect(featureFlags.set).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.BRANCHES,
        true,
        expect.objectContaining({
          source: FeatureFlagSource.PLATFORM_ADMIN,
          actorId: ACTOR.id,
        }),
      );
      expect(featureFlags.setSuspension).not.toHaveBeenCalled();
    });

    it('clears the grant for `inherit` without suspending anything', async () => {
      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.BRANCHES,
        'inherit',
        undefined,
        ACTOR,
      );

      // `is_enabled: false` means "not granted" — the subscription decides. It
      // is NOT a denial; that is `is_suspended`, and conflating the two is what
      // let a stray toggle de-provision a paying clinic.
      expect(featureFlags.set).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.BRANCHES,
        false,
        expect.anything(),
      );
      expect(featureFlags.setSuspension).not.toHaveBeenCalled();
    });

    it('lifts an existing suspension and grants in ONE transaction', async () => {
      flags.findOne.mockResolvedValueOnce({
        is_suspended: true,
        is_enabled: false,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      });

      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.BRANCHES,
        'granted',
        undefined,
        ACTOR,
      );

      expect(featureFlags.setSuspension).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.BRANCHES,
        false,
        expect.objectContaining({ manager: expect.anything() }),
      );
      expect(featureFlags.set).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.BRANCHES,
        true,
        expect.objectContaining({ manager: expect.anything() }),
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('does not touch the suspension when there is none to lift', async () => {
      flags.findOne.mockResolvedValueOnce({
        is_suspended: false,
        is_enabled: false,
        source: FeatureFlagSource.PLATFORM_ADMIN,
      });

      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.BRANCHES,
        'granted',
        undefined,
        ACTOR,
      );
      // A needless write would churn `updated_at` on a row nothing changed
      // about, making the row-level audit trail lie about when it last moved.
      expect(featureFlags.setSuspension).not.toHaveBeenCalled();
    });

    it('requires a reason for `suspended` and keeps any existing grant', async () => {
      await expect(
        service.setTenantFeatureState(
          TENANT,
          FeatureKey.BRANCHES,
          'suspended',
          '  ',
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });

      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.BRANCHES,
        'suspended',
        'Abuse report #4821',
        ACTOR,
      );
      expect(featureFlags.setSuspension).toHaveBeenCalledWith(
        TENANT,
        FeatureKey.BRANCHES,
        true,
        expect.objectContaining({ reason: 'Abuse report #4821' }),
      );
      // The grant is deliberately left alone: the two columns say different
      // things, and clearing it would destroy the state to return to.
      expect(featureFlags.set).not.toHaveBeenCalled();
    });

    it.each([FeatureKey.BILLING, FeatureKey.SUPPORT, FeatureKey.CORE_WORKSPACE])(
      'refuses to suspend the always-on capability "%s"',
      async (key) => {
        await expect(
          service.setTenantFeatureState(TENANT, key, 'suspended', 'x', ACTOR),
        ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      },
    );

    it('refuses a key that is not a real capability', async () => {
      await expect(
        service.setTenantFeatureState(
          TENANT,
          'not.a.feature',
          'granted',
          undefined,
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(featureFlags.set).not.toHaveBeenCalled();
    });

    it('records the transition, with what the grant opens', async () => {
      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.WHATSAPP,
        'granted',
        undefined,
        ACTOR,
      );

      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'FEATURE_FLAG_STATE_SET',
          entity_id: TENANT,
          old_values: expect.objectContaining({ state: 'inherit' }),
          new_values: expect.objectContaining({
            state: 'granted',
            // The declared dependency closure, so the audit answers "what did
            // this change?" without re-deriving it later.
            grants: expect.arrayContaining([
              FeatureKey.WHATSAPP,
              FeatureKey.CONVERSATIONS,
              FeatureKey.CRM,
            ]),
          }),
        }),
      );
    });

    it('rolls the whole transition back if the audit write fails', async () => {
      auditRepo.save.mockRejectedValueOnce(new Error('audit table down'));
      await expect(
        service.setTenantFeatureState(
          TENANT,
          FeatureKey.BRANCHES,
          'granted',
          undefined,
          ACTOR,
        ),
      ).rejects.toThrow('audit table down');
    });

    it('busts the tenant cache after the commit', async () => {
      await service.setTenantFeatureState(
        TENANT,
        FeatureKey.BRANCHES,
        'granted',
        undefined,
        ACTOR,
      );
      expect(accessCache.invalidate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('bulkSetTenantFeatureState', () => {
    it('applies the state to every key in one transaction', async () => {
      const res = await service.bulkSetTenantFeatureState(
        TENANT,
        [FeatureKey.BRANCHES, FeatureKey.CRM, FeatureKey.STAFF],
        'granted',
        undefined,
        ACTOR,
      );

      expect(res).toEqual({ updated: 3 });
      expect(featureFlags.set).toHaveBeenCalledTimes(3);
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates repeated keys', async () => {
      const res = await service.bulkSetTenantFeatureState(
        TENANT,
        [FeatureKey.BRANCHES, FeatureKey.BRANCHES],
        'granted',
        undefined,
        ACTOR,
      );
      expect(res).toEqual({ updated: 1 });
    });

    it('validates the WHOLE batch before writing any of it', async () => {
      // A partial apply leaves the tenant in a state neither the operator nor
      // the audit record describes.
      await expect(
        service.bulkSetTenantFeatureState(
          TENANT,
          [FeatureKey.BRANCHES, 'not.a.feature'],
          'granted',
          undefined,
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(featureFlags.set).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses the batch when it would suspend an always-on capability', async () => {
      await expect(
        service.bulkSetTenantFeatureState(
          TENANT,
          [FeatureKey.BRANCHES, FeatureKey.BILLING],
          'suspended',
          'incident',
          ACTOR,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(featureFlags.setSuspension).not.toHaveBeenCalled();
    });
  });
});
