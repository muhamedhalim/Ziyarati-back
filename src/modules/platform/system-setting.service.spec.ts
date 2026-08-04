import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SystemSettingService } from './system-setting.service';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';
import { PlatformAdminAuditService } from './platform-admin-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

describe('SystemSettingService', () => {
  let service: SystemSettingService;
  let settings: MockRepository;
  let audit: { record: jest.Mock };
  let tenantContext: { getUser: jest.Mock };

  beforeEach(async () => {
    settings = createMockRepository();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    tenantContext = { getUser: jest.fn().mockReturnValue({ id: 'super-admin-1' }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingService,
        { provide: getRepositoryToken(SystemSetting), useValue: settings },
        { provide: PlatformAdminAuditService, useValue: audit },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(SystemSettingService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a setting with a unique key', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    settings.save.mockResolvedValueOnce({ id: 's1' });
    await expect(service.create({ key: 'k', value: { a: 1 } } as any)).resolves.toEqual({ id: 's1' });
  });

  it('rejects a duplicate key', async () => {
    settings.findOne.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.create({ key: 'k' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('updates value and re-checks key uniqueness on rename', async () => {
    settings.findOne
      .mockResolvedValueOnce({ id: 's1', key: 'old', value: {} }) // get
      .mockResolvedValueOnce(null); // key unique
    settings.save.mockImplementationOnce(async (s: any) => s);
    const res = await service.update('s1', { key: 'new', value: { b: 2 } } as any);
    expect(res).toEqual(expect.objectContaining({ key: 'new', value: { b: 2 } }));
  });

  it('get throws when the setting does not exist', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    await expect(service.get('x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('removes and lists settings', async () => {
    settings.findOne.mockResolvedValueOnce({ id: 's1' });
    await expect(service.remove('s1')).resolves.toEqual({ id: 's1', deleted: true });

    settings.findAndCount.mockResolvedValueOnce([[{ id: 's1' }], 1]);
    await expect(service.list({ page: 1, limit: 10, key: 'bil' } as any)).resolves.toMatchObject({ total: 1 });
  });

  // FND-015 — these mutations previously wrote NO audit entry and captured no
  // actor. Each now records at the service seam so no controller can bypass it.
  describe('FND-015 — audit trail', () => {
    it('audits a successful create with the acting super admin and the after-value', async () => {
      settings.findOne.mockResolvedValueOnce(null);
      settings.save.mockResolvedValueOnce({ id: 's1', key: 'k', value: { a: 1 } });

      await service.create({ key: 'k', value: { a: 1 } } as any);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'super-admin-1',
          entityType: 'system_setting',
          entityId: 's1',
          before: null,
          after: { key: 'k', value: { a: 1 } },
        }),
      );
    });

    it('audits a successful update with both the before and after value', async () => {
      settings.findOne
        .mockResolvedValueOnce({ id: 's1', key: 'billing.mode', value: { mode: 'free' } })
        .mockResolvedValueOnce(null); // key unique on rename
      settings.save.mockImplementationOnce(async (s: any) => s);

      await service.update('s1', { key: 'billing.mode', value: { mode: 'paid' } } as any);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'super-admin-1',
          entityType: 'system_setting',
          entityId: 's1',
          before: { key: 'billing.mode', value: { mode: 'free' } },
          after: { key: 'billing.mode', value: { mode: 'paid' } },
        }),
      );
    });

    it('audits a successful delete with the removed value as "before" and null "after"', async () => {
      settings.findOne.mockResolvedValueOnce({ id: 's1', key: 'k', value: { a: 1 } });

      await service.remove('s1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'super-admin-1',
          entityType: 'system_setting',
          entityId: 's1',
          before: { key: 'k', value: { a: 1 } },
          after: null,
        }),
      );
    });

    it('audits a REJECTED create too (AD-14: both success and refusal are recorded)', async () => {
      settings.findOne.mockResolvedValueOnce({ id: 'existing', key: 'k' });
      await expect(service.create({ key: 'k' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'platform_admin.system_setting.create_rejected',
          userId: 'super-admin-1',
          entityType: 'system_setting',
          entityId: 'existing',
        }),
      );
    });
  });
});
