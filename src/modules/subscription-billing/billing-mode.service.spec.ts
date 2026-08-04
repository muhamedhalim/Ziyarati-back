import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BillingModeService } from './billing-mode.service';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { BillingMode } from './platform-billing.constants';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';
import { PlatformAdminAuditService } from '../platform/platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

describe('BillingModeService', () => {
  let service: BillingModeService;
  let settings: MockRepository;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };

  beforeEach(async () => {
    settings = createMockRepository();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = { getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BillingModeService,
        { provide: getRepositoryToken(SystemSetting), useValue: settings },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: TenantContextService, useValue: tenantContext },
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
    settings.findOne.mockResolvedValueOnce({ value: { mode: BillingMode.PAID } });
    expect(await service.isPaidMode()).toBe(true);
  });

  it('caches the mode (a second read does not hit the DB)', async () => {
    settings.findOne.mockResolvedValueOnce({ value: { mode: BillingMode.PAID } });
    await service.get();
    await service.get();
    expect(settings.findOne).toHaveBeenCalledTimes(1);
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
    settings.findOne.mockResolvedValueOnce({ key: 'billing.mode', value: { mode: BillingMode.FREE } });
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
    settings.save.mockImplementationOnce(async (s: any) => ({ id: 'setting-1', ...s }));

    await service.set(BillingMode.PAID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { mode: BillingMode.FREE },
        after: { mode: BillingMode.PAID },
      }),
    );
  });
});
