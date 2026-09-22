import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { SystemSettingService } from './system-setting.service';
import { SettingKey } from './settings.registry';
import { AI_MODEL_IDS } from '../ai/routing/ai-model-registry';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
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

  // FND-015 — upsertByKey previously wrote NO audit entry and captured no
  // actor. It now records at the service seam so no controller can bypass it.
  it('FND-015: audits a successful upsertByKey with the acting super admin and the before/after value', async () => {
    settings.findOne.mockResolvedValueOnce({ id: 's1', key: SettingKey.MAINTENANCE_MODE, value: false });
    settings.save.mockImplementationOnce(async (s: any) => s);

    await service.upsertByKey(SettingKey.MAINTENANCE_MODE, true);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform_admin.system_setting.upsert',
        userId: 'super-admin-1',
        entityType: 'system_setting',
        entityId: 's1',
        before: { key: SettingKey.MAINTENANCE_MODE, value: false },
        after: { key: SettingKey.MAINTENANCE_MODE, value: true },
      }),
    );
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

/**
 * `/platform/system-settings` as the model-policy write boundary.
 *
 * The page renders `GET /platform/settings/typed` verbatim — it holds no model
 * list of its own — so what the registry permits is exactly what the dropdown
 * offers. These cases are about the OTHER direction: a request that never went
 * near the page.
 */
describe('SystemSettingService — ai.default_model policy', () => {
  let settings: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; remove: jest.Mock; findAndCount: jest.Mock };
  let service: SystemSettingService;

  beforeEach(() => {
    settings = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (row) => ({ id: 's1', ...row })),
      create: jest.fn().mockImplementation((row) => row),
      remove: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    service = new SystemSettingService(
      settings as any,
      { record: jest.fn() } as any,
      { getUser: () => ({ id: 'admin-1' }) } as any,
    );
  });

  it.each([...AI_MODEL_IDS])('accepts %s', async (model) => {
    await expect(
      service.upsertByKey(SettingKey.AI_DEFAULT_MODEL, model),
    ).resolves.toMatchObject({ value: model });
  });

  it.each([
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-5.6-sol',
    'claude-3-opus',
    'GPT-5.6-LUNA',
    '',
    null,
  ])('rejects %p at the typed endpoint', async (model) => {
    await expect(
      service.upsertByKey(SettingKey.AI_DEFAULT_MODEL, model),
    ).rejects.toThrow(/must be one of/);
    expect(settings.save).not.toHaveBeenCalled();
  });

  /**
   * DIRECT API MANIPULATION. `upsertByKey` is the ONLY way to write a
   * registry-defined setting, so it is the only place the enum validator has to
   * hold. Asserted structurally as well as behaviourally: a second write path
   * that skipped `validateValue` — the free-form raw KV editor used to be
   * exactly that — would re-open the policy without any of the cases above
   * failing.
   */
  it('has no write path that skips the registry validator', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source: string = require('node:fs').readFileSync(
      require.resolve('./system-setting.service.ts'),
      'utf8',
    );
    // `upsertByKey` validates before it does anything else...
    expect(source).toMatch(
      /async upsertByKey\([^)]*\)[^{]*\{\s*this\.validateValue\(key, value\);/,
    );
    // ...and it is the only method that persists a row, so there is no second
    // way in. Both halves matter: the first without the second was true while
    // the raw KV editor existed alongside it.
    const savingMethods = [...source.matchAll(/^ {2}(?:async )?(\w+)\(/gm)]
      .map((m) => m[1])
      .filter((name) => {
        const start = source.indexOf(`${name}(`);
        const body = source.slice(start, source.indexOf('\n  }', start));
        return body.includes('this.settings.save(');
      });
    expect(savingMethods).toEqual(['upsertByKey']);
  });

  it('offers exactly the permitted models to the dropdown, with no client-side list', () => {
    const definition = service.getRegistry()[SettingKey.AI_DEFAULT_MODEL];
    expect(definition.type).toBe('enum');
    expect([...(definition.allowedValues ?? [])].sort()).toEqual(
      [...AI_MODEL_IDS].sort(),
    );
    // And its own default has to be one of them, or a fresh install would ship
    // a value its own validator refuses.
    expect(AI_MODEL_IDS).toContain(definition.default);
  });

  it('serves the platform default with no row present, so a fresh install is valid', async () => {
    settings.findOne.mockResolvedValue(null);
    const value = await service.getTyped<string>(SettingKey.AI_DEFAULT_MODEL);
    expect(AI_MODEL_IDS).toContain(value);
  });
});

/**
 * F-22 FIXED (was: the effective AI model was "visible nowhere" — `.env`'s
 * `OPENAI_CHAT_MODEL` looked authoritative but was dead code, and
 * `ai.default_model`'s own value carried no indication of whether a super
 * admin had ever actually set it). `listTyped()` now reports `source` for
 * every setting, so `ai.default_model` specifically stops being ambiguous.
 */
describe('SystemSettingService — F-22 listTyped() source', () => {
  let settings: MockRepository;
  let service: SystemSettingService;

  beforeEach(() => {
    settings = createMockRepository();
    service = new SystemSettingService(
      settings as any,
      { record: jest.fn() } as any,
      { getUser: () => ({ id: 'admin-1' }) } as any,
    );
  });

  it('reports source "default" for ai.default_model when no row exists', async () => {
    settings.findOne.mockResolvedValue(undefined);
    const list = await service.listTyped();
    const entry = list.find((s) => s.key === SettingKey.AI_DEFAULT_MODEL);
    expect(entry?.source).toBe('default');
    expect(entry?.value).toBe(entry?.default);
  });

  it('reports source "override" for ai.default_model once a super admin has upserted it', async () => {
    settings.findOne.mockResolvedValue({ id: 's1', key: SettingKey.AI_DEFAULT_MODEL, value: 'gpt-5.6-luna' });
    const list = await service.listTyped();
    const entry = list.find((s) => s.key === SettingKey.AI_DEFAULT_MODEL);
    expect(entry?.source).toBe('override');
    expect(entry?.value).toBe('gpt-5.6-luna');
  });

  it('reports source independently per key, not platform-wide', async () => {
    settings.findOne.mockImplementation(async ({ where: { key } }: { where: { key: SettingKey } }) =>
      key === SettingKey.AI_DEFAULT_MODEL ? { id: 's1', key, value: 'gpt-5.6-terra' } : undefined,
    );
    const list = await service.listTyped();
    const model = list.find((s) => s.key === SettingKey.AI_DEFAULT_MODEL);
    const other = list.find((s) => s.key === SettingKey.MAINTENANCE_MODE);
    expect(model?.source).toBe('override');
    expect(other?.source).toBe('default');
  });
});
