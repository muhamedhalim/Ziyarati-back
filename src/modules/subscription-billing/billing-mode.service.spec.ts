import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BillingModeService } from './billing-mode.service';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { BillingMode } from './platform-billing.constants';
import {
  createMockAccessCache,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';
import { AccessCacheService } from './access-cache.service';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

describe('BillingModeService', () => {
  let service: BillingModeService;
  let settings: MockRepository;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };
  let accessCache: ReturnType<typeof createMockAccessCache>;

  beforeEach(async () => {
    settings = createMockRepository();
    accessCache = createMockAccessCache();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = {
      getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingModeService,
        { provide: getRepositoryToken(SystemSetting), useValue: settings },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: TenantContextService, useValue: tenantContext },
        { provide: AccessCacheService, useValue: accessCache },
      ],
    }).compile();
    service = moduleRef.get(BillingModeService);
  });

  afterEach(() => jest.clearAllMocks());

  it('defaults to FREE when never configured', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    expect(await service.get()).toBe(BillingMode.FREE);
  });

  it('reads PAID mode and reports isPaidMode true', async () => {
    settings.findOne.mockResolvedValueOnce({
      value: { mode: BillingMode.PAID },
    });
    expect(await service.isPaidMode()).toBe(true);
  });

  it('caches the mode (a second read does not hit the DB)', async () => {
    settings.findOne.mockResolvedValueOnce({
      value: { mode: BillingMode.PAID },
    });
    await service.get();
    await service.get();
    expect(settings.findOne).toHaveBeenCalledTimes(1);
  });

  /**
   * Plan §16. Flipping the platform to PAID changes precedence rule 2 for EVERY
   * tenant at once — it is the single switch that turns the platform from
   * ungated to gated. Without a bust, every replica but the one that handled
   * the write would keep serving cached "allowed" decisions until its TTL
   * lapsed, which is precisely the staleness the cache is forbidden to produce.
   */
  it('busts every cached access decision when the platform mode changes', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    await service.set(BillingMode.PAID);
    expect(accessCache.invalidateAll).toHaveBeenCalled();
  });

  // FND-047: on a cache miss inside a caller's open transaction (isEnforced ->
  // isPaidMode), a manager must be honored so this read reuses the caller's own
  // connection instead of borrowing a second one from the pool.
  describe('manager threading (FND-047)', () => {
    it('reads through manager.getRepository(SystemSetting) when a manager is supplied', async () => {
      const managerSettings = {
        findOne: jest
          .fn()
          .mockResolvedValueOnce({ value: { mode: BillingMode.PAID } }),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue(managerSettings),
      } as any;

      expect(await service.isPaidMode(manager)).toBe(true);

      expect(managerSettings.findOne).toHaveBeenCalledTimes(1);
      expect(settings.findOne).not.toHaveBeenCalled();
    });

    it('a fresh (non-cached) call with no manager still uses the injected repo (standalone callers unchanged)', async () => {
      settings.findOne.mockResolvedValueOnce({
        value: { mode: BillingMode.PAID },
      });
      expect(await service.isPaidMode()).toBe(true);
      expect(settings.findOne).toHaveBeenCalledTimes(1);
    });

    it('a cache HIT never touches the manager either (no connection needed at all)', async () => {
      settings.findOne.mockResolvedValueOnce({
        value: { mode: BillingMode.PAID },
      });
      await service.get(); // primes the cache via the plain repo
      const manager = { getRepository: jest.fn() } as any;
      expect(await service.get(manager)).toBe(BillingMode.PAID);
      expect(manager.getRepository).not.toHaveBeenCalled();
    });
  });

  it('set() upserts a new setting and refreshes the cache immediately', async () => {
    settings.findOne.mockResolvedValueOnce(null); // no existing setting
    const res = await service.set(BillingMode.PAID);
    expect(res).toEqual({ mode: BillingMode.PAID });
    expect(settings.save).toHaveBeenCalled();
    // cache primed → get() returns without another DB read
    expect(await service.get()).toBe(BillingMode.PAID);
    expect(settings.findOne).toHaveBeenCalledTimes(1);
  });

  it('set() updates an existing setting row', async () => {
    settings.findOne.mockResolvedValueOnce({
      key: 'billing.mode',
      value: { mode: BillingMode.FREE },
    });
    await service.set(BillingMode.PAID);
    const saved = settings.save.mock.calls[0][0];
    expect(saved.value).toEqual({ mode: BillingMode.PAID });
  });

  // FND-015 — this platform-wide switch previously wrote NO audit entry.
  it('audits a mode switch with the acting super admin and the before/after mode', async () => {
    settings.findOne.mockResolvedValueOnce({
      id: 'setting-1',
      key: 'billing.mode',
      value: { mode: BillingMode.FREE },
    });
    settings.save.mockImplementationOnce(async (s: any) => s);

    await service.set(BillingMode.PAID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform_admin.billing_mode.set',
        userId: 'super-admin-1',
        entityType: 'billing_mode',
        entityId: 'setting-1',
        before: { mode: BillingMode.FREE },
        after: { mode: BillingMode.PAID },
      }),
    );
  });

  it('audits the FIRST-ever mode switch (no prior row) against the documented default', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    settings.save.mockImplementationOnce(async (s: any) => ({
      id: 'setting-1',
      ...s,
    }));

    await service.set(BillingMode.PAID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { mode: BillingMode.FREE },
        after: { mode: BillingMode.PAID },
      }),
    );
  });
});
