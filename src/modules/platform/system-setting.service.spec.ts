import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { SystemSettingService } from './system-setting.service';
import { SettingKey } from './settings.registry';
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

  // ai.default_temperature is the registry's only 'number' entry with a
  // `step`, and upsertByKey (PUT /platform/settings/by-key/:key) is the path
  // the typed-settings UI actually saves through.
  describe('typed settings — number validation (upsertByKey)', () => {
    it('accepts a value on the 0.1 step grid', async () => {
      settings.findOne.mockResolvedValueOnce({ id: 's1', key: SettingKey.AI_DEFAULT_TEMP, value: 0.2 });
      settings.save.mockImplementationOnce(async (s: any) => s);
      await expect(
        service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 0.3),
      ).resolves.toMatchObject({ value: 0.3 });
    });

    it('rejects a value off the 0.1 step grid', async () => {
      await expect(
        service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 0.25),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a value below the registry minimum', async () => {
      await expect(
        service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, -0.1),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a value above the registry maximum (range is 0–1, not 0–2)', async () => {
      await expect(
        service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 1.1),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts both range endpoints', async () => {
      settings.findOne.mockResolvedValue({ id: 's1', key: SettingKey.AI_DEFAULT_TEMP, value: 0.2 });
      settings.save.mockImplementation(async (s: any) => s);
      await expect(service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 0)).resolves.toMatchObject({ value: 0 });
      await expect(service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 1)).resolves.toMatchObject({ value: 1 });
    });

    it('rejects a non-numeric value for a number setting', async () => {
      await expect(
        service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 'high' as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('is not fooled by floating-point step arithmetic (0.1 + 0.2 !== 0.3 in IEEE 754)', async () => {
      settings.findOne.mockResolvedValueOnce({ id: 's1', key: SettingKey.AI_DEFAULT_TEMP, value: 0.2 });
      settings.save.mockImplementationOnce(async (s: any) => s);
      await expect(
        service.upsertByKey(SettingKey.AI_DEFAULT_TEMP, 0.1 + 0.2),
      ).resolves.toMatchObject({ value: 0.1 + 0.2 });
    });

    it('does not enforce a step grid for a number setting that declares none', async () => {
      settings.findOne.mockResolvedValueOnce({ id: 's1', key: SettingKey.TENANT_QUOTA_GB, value: 5 });
      settings.save.mockImplementationOnce(async (s: any) => s);
      await expect(
        service.upsertByKey(SettingKey.TENANT_QUOTA_GB, 7),
      ).resolves.toMatchObject({ value: 7 });
    });
  });
});
