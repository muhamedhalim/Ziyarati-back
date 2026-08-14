import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { FeatureFlagService } from './feature-flag.service';
import { FeatureKey } from './feature-registry';
import {
  FeatureFlag,
  FeatureFlagSource,
} from '../../entities/SaaS-Core/FeatureFlag';
import { ErrorCode } from '../../common/errors';
import {
  createMockAccessCache,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { AccessCacheService } from './access-cache.service';

const TENANT = 't1';
const KEY = FeatureKey.AI_ASSISTANT;
const PLATFORM = { source: FeatureFlagSource.PLATFORM_ADMIN };

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;
  let flags: MockRepository;
  let accessCache: ReturnType<typeof createMockAccessCache>;

  beforeEach(async () => {
    flags = createMockRepository();
    accessCache = createMockAccessCache();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagService,
        { provide: getRepositoryToken(FeatureFlag), useValue: flags },
        { provide: AccessCacheService, useValue: accessCache },
      ],
    }).compile();
    service = moduleRef.get(FeatureFlagService);
  });

  afterEach(() => jest.clearAllMocks());

  it('lists tenant flags', async () => {
    flags.find.mockResolvedValueOnce([{ feature_key: KEY }]);
    await expect(service.list(TENANT)).resolves.toHaveLength(1);
  });

  it('set creates a new flag when none exists, recording provenance', async () => {
    flags.findOne.mockResolvedValueOnce(null);
    flags.create.mockImplementationOnce((f: unknown) => f);
    flags.save.mockImplementationOnce(async (f: unknown) => f);

    const res = await service.set(TENANT, KEY, true, {
      ...PLATFORM,
      actorId: 'admin-1',
    });

    expect(res).toEqual(
      expect.objectContaining({
        is_enabled: true,
        source: FeatureFlagSource.PLATFORM_ADMIN,
        updated_by: 'admin-1',
      }),
    );
  });

  it('set updates an existing flag and re-stamps the source', async () => {
    // A tenant-written row later overwritten by a super-admin must become
    // authoritative — otherwise the platform's own grant would be ignored.
    flags.findOne.mockResolvedValueOnce({
      feature_key: KEY,
      is_enabled: false,
      source: FeatureFlagSource.TENANT,
    });
    flags.save.mockImplementationOnce(async (f: unknown) => f);

    const res = await service.set(TENANT, KEY, true, PLATFORM);

    expect(res.is_enabled).toBe(true);
    expect(res.source).toBe(FeatureFlagSource.PLATFORM_ADMIN);
    expect(flags.create).not.toHaveBeenCalled();
  });

  /**
   * Plan §16. A grant or a suspension that is still cached has not taken
   * effect. The suspension case matters most: it is the incident kill-switch,
   * and an operator throwing it expects it to bind on the next request across
   * every replica, not when a TTL happens to lapse.
   */
  describe('access-cache invalidation', () => {
    it('busts the tenant after a grant is written', async () => {
      flags.findOne.mockResolvedValueOnce(null);
      await service.set(TENANT, KEY, true, PLATFORM);
      expect(accessCache.invalidate).toHaveBeenCalledWith(TENANT);
    });

    it('busts the tenant after a suspension is written', async () => {
      flags.findOne.mockResolvedValueOnce(null);
      await service.setSuspension(TENANT, KEY, true, { reason: 'abuse' });
      expect(accessCache.invalidate).toHaveBeenCalledWith(TENANT);
    });
  });

  describe('getStates', () => {
    it('treats only platform and billing-upgrade rows as grants', async () => {
      flags.find.mockResolvedValueOnce([
        {
          feature_key: FeatureKey.WHATSAPP,
          is_enabled: true,
          is_suspended: false,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
        {
          feature_key: FeatureKey.CAMPAIGNS,
          is_enabled: true,
          is_suspended: false,
          source: FeatureFlagSource.BILLING_UPGRADE,
        },
        {
          // The paid-plan bypass: a clinic writing its own grant.
          feature_key: FeatureKey.PAYMENTS,
          is_enabled: true,
          is_suspended: false,
          source: FeatureFlagSource.TENANT,
        },
      ]);

      const states = await service.getStates(TENANT);

      expect(states.get(FeatureKey.WHATSAPP)?.granted).toBe(true);
      expect(states.get(FeatureKey.CAMPAIGNS)?.granted).toBe(true);
      expect(states.get(FeatureKey.PAYMENTS)?.granted).toBe(false);
    });

    it('reports a suspension regardless of who recorded it', async () => {
      // Honouring a suspension can only ever REMOVE access, so its provenance
      // does not need to be trusted the way a grant's does.
      flags.find.mockResolvedValueOnce([
        {
          feature_key: FeatureKey.WHATSAPP,
          is_enabled: true,
          is_suspended: true,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
      ]);
      const states = await service.getStates(TENANT);
      expect(states.get(FeatureKey.WHATSAPP)?.suspended).toBe(true);
    });
  });

  describe('isGranted', () => {
    it('is false when the row is missing', async () => {
      flags.findOne.mockResolvedValueOnce(null);
      expect(await service.isGranted(TENANT, KEY)).toBe(false);
    });

    it('is false when the capability is suspended, even if enabled', async () => {
      flags.findOne.mockResolvedValueOnce({
        is_enabled: true,
        is_suspended: true,
      });
      expect(await service.isGranted(TENANT, KEY)).toBe(false);
    });

    it('is true for an enabled, unsuspended authoritative row', async () => {
      flags.findOne.mockResolvedValueOnce({
        is_enabled: true,
        is_suspended: false,
      });
      expect(await service.isGranted(TENANT, KEY)).toBe(true);
    });
  });

  it('setSuspension records reason, actor and timestamp, and clears them on lift', async () => {
    flags.findOne.mockResolvedValue({ feature_key: KEY, is_enabled: true });
    flags.save.mockImplementation(async (f: unknown) => f);

    const on = await service.setSuspension(TENANT, KEY, true, {
      actorId: 'admin-1',
      reason: 'abuse investigation',
    });
    expect(on.is_suspended).toBe(true);
    expect(on.suspended_reason).toBe('abuse investigation');
    expect(on.suspended_by).toBe('admin-1');
    expect(on.suspended_at).toBeInstanceOf(Date);

    const off = await service.setSuspension(TENANT, KEY, false, {
      actorId: 'admin-1',
    });
    expect(off.is_suspended).toBe(false);
    expect(off.suspended_reason).toBeNull();
    expect(off.suspended_at).toBeNull();
  });

  it('isEnabled defaults to false when the flag is missing', async () => {
    flags.findOne.mockResolvedValueOnce(null);
    expect(await service.isEnabled(TENANT, KEY)).toBe(false);
  });

  it('assertEnabled passes when granted and throws 403 when not', async () => {
    flags.findOne.mockResolvedValueOnce({
      is_enabled: true,
      is_suspended: false,
    });
    await expect(service.assertEnabled(TENANT, KEY)).resolves.toBeUndefined();

    flags.findOne.mockResolvedValueOnce(null);
    await expect(service.assertEnabled(TENANT, KEY)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });
});
