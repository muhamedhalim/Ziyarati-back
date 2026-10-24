import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { WhatsappTemplateLibraryService } from './template-library.service';
import { TEMPLATE_LIBRARY } from './template-library.catalog';
import { WhatsappTemplateService } from '../whatsapp-template.service';
import { WhatsappTemplate } from '../../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { ActivityAuditService } from '../../activity-log/activity-audit.service';
import { ErrorCode } from '../../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../../test/utils/mock-factories';
import {
  WHATSAPP_TEMPLATE_AUDIT_ACTION,
  WHATSAPP_TEMPLATE_STATUS,
} from '../whatsapp.constants';

const TENANT = 't1';

describe('WhatsappTemplateLibraryService', () => {
  let service: WhatsappTemplateLibraryService;
  let templates: MockRepository;
  let accounts: MockRepository;
  let tenants: MockRepository;
  let templateService: { toView: jest.Mock; findOneView: jest.Mock };
  let audit: { record: jest.Mock };

  const ACCOUNT = {
    id: 'acc-1',
    is_default: true,
    display_phone_number: '+966 50 000 0000',
  };

  beforeEach(async () => {
    templates = createMockRepository();
    accounts = createMockRepository();
    tenants = createMockRepository();
    accounts.find.mockResolvedValue([ACCOUNT]);
    tenants.findOne.mockResolvedValue({
      id: TENANT,
      contact_phone: '+966 55 123 4567',
    });
    templates.create.mockImplementation((t: any) => ({ ...t }));
    templates.save.mockImplementation(async (t: any) => ({
      ...t,
      id: 'tpl-new',
    }));
    templateService = {
      toView: jest.fn((r: any) => ({ ...r, view: true })),
      findOneView: jest.fn(async (_t: string, id: string) => ({
        id,
        view: true,
      })),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappTemplateLibraryService,
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: WhatsappTemplateService, useValue: templateService },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              k === 'APP_URL' ? 'https://app.ziyaratech.test/' : undefined,
          },
        },
        { provide: ActivityAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(WhatsappTemplateLibraryService);
  });

  const notAdopted = () => {
    templates.findOne.mockResolvedValue(null); // by key, then by name
  };

  describe('adopt', () => {
    it('creates a local DRAFT with no Meta identity — and has no way to call Meta at all', async () => {
      notAdopted();
      const res = await service.adopt(
        TENANT,
        'appointment_reminder_24h',
        {},
        'user-1',
      );

      expect(res.created).toBe(true);
      const saved = templates.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        name: 'appointment_reminder_24h',
        language: 'ar',
        category: 'UTILITY',
        status: WHATSAPP_TEMPLATE_STATUS.DRAFT,
        library_key: 'appointment_reminder_24h',
        library_version: 1,
        provider_template_id: null,
        waba_id: null,
        whatsapp_account: { id: 'acc-1' },
        tenant: { id: TENANT },
      });
      // The service has no Meta client dependency: adoption cannot submit anything.
      expect(Object.keys(service as any)).not.toContain('graph');
    });

    it('fills install-time values: app URL without a trailing slash, clinic phone in E.164', async () => {
      notAdopted();
      await service.adopt(TENANT, 'appointment_confirmation', {});
      const confirmation = templates.save.mock.calls[0][0];
      const url = confirmation.components.components.find(
        (c: any) => c.type === 'BUTTONS',
      ).buttons[0];
      expect(url.url).toBe(
        'https://app.ziyaratech.test/appointment-action/{{1}}',
      );
      expect(url.example[0]).toMatch(
        /^https:\/\/app\.ziyaratech\.test\/appointment-action\//,
      );

      templates.save.mockClear();
      await service.adopt(TENANT, 'appointment_reminder_24h', {});
      const call = templates.save.mock.calls[0][0].components.components.find(
        (c: any) => c.type === 'BUTTONS',
      ).buttons[0];
      expect(call.phone_number).toBe('+966551234567'); // tenant contact phone wins over the WhatsApp number
    });

    it('an explicit international phone wins; a national-format one is left blank rather than guessed', async () => {
      notAdopted();
      await service.adopt(TENANT, 'appointment_reminder_24h', {
        phoneNumber: '+966 50 111 2222',
      });
      let btn = templates.save.mock.calls[0][0].components.components.find(
        (c: any) => c.type === 'BUTTONS',
      ).buttons[0];
      expect(btn.phone_number).toBe('+966501112222');

      // `05…` has no country code — it must not become `+05…`. With the tenant and
      // account phones also unusable, the field stays blank for the owner.
      templates.save.mockClear();
      tenants.findOne.mockResolvedValue({
        id: TENANT,
        contact_phone: '0551234567',
      });
      accounts.find.mockResolvedValue([
        { id: 'acc-1', is_default: true, display_phone_number: null },
      ]);
      await service.adopt(TENANT, 'appointment_reminder_24h', {
        phoneNumber: '0500000001',
      });
      btn = templates.save.mock.calls[0][0].components.components.find(
        (c: any) => c.type === 'BUTTONS',
      ).buttons[0];
      expect(btn.phone_number).toBeUndefined();
    });

    it('binds the catalog’s default data sources, leaving the promotion’s offer and date unbound', async () => {
      notAdopted();
      await service.adopt(TENANT, 'clinic_special_offer', {
        offerUrl: 'https://c.test/offers',
      });
      const saved = templates.save.mock.calls[0][0];
      expect(saved.variable_mapping).toEqual({
        '1': 'patient_first_name',
        '2': 'clinic_name',
      });
      const url = saved.components.components
        .find((c: any) => c.type === 'BUTTONS')
        .buttons.find((b: any) => b.type === 'URL');
      expect(url.url).toBe('https://c.test/offers');
    });

    it('is idempotent: adopting again returns the existing copy and writes nothing', async () => {
      templates.findOne.mockResolvedValue({
        id: 'tpl-existing',
        library_key: 'appointment_reminder_24h',
      });
      const res = await service.adopt(TENANT, 'appointment_reminder_24h', {});
      expect(res.created).toBe(false);
      expect(templates.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('converges on the winner when two requests race (unique violation)', async () => {
      templates.findOne
        .mockResolvedValueOnce(null) // by key
        .mockResolvedValueOnce(null) // by name
        .mockResolvedValueOnce({
          id: 'tpl-winner',
          library_key: 'appointment_reminder_24h',
        }); // by key again
      templates.save.mockRejectedValueOnce({ code: '23505' });
      const res = await service.adopt(TENANT, 'appointment_reminder_24h', {});
      expect(res.created).toBe(false);
      expect(res.template).toMatchObject({ id: 'tpl-winner' });
    });

    it('refuses to take over a name a different (non-library) template already uses', async () => {
      templates.findOne
        .mockResolvedValueOnce(null) // by key
        .mockResolvedValueOnce({
          id: 'other',
          name: 'appointment_reminder_24h',
          language: 'ar',
          deleted_at: null,
        });
      await expect(
        service.adopt(TENANT, 'appointment_reminder_24h', {}),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { reason: 'NAME_CONFLICT' },
      });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('revives a soft-deleted tombstone of the same name instead of colliding', async () => {
      templates.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'tomb',
        name: 'appointment_reminder_24h',
        language: 'ar',
        deleted_at: new Date(),
        provider_template_id: 'old-meta',
      });
      await service.adopt(TENANT, 'appointment_reminder_24h', {});
      const saved = templates.save.mock.calls[0][0];
      expect(saved.id).toBe('tomb');
      expect(saved.deleted_at).toBeNull();
      expect(saved.provider_template_id).toBeNull(); // the old Meta identity is gone
      expect(saved.status).toBe(WHATSAPP_TEMPLATE_STATUS.DRAFT);
    });

    it('rejects an account that is not this tenant’s', async () => {
      notAdopted();
      accounts.findOne.mockResolvedValue(null);
      await expect(
        service.adopt(TENANT, 'appointment_reminder_24h', {
          accountId: 'foreign',
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(accounts.findOne.mock.calls[0][0].where).toMatchObject({
        id: 'foreign',
        tenant: { id: TENANT },
      });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('404s an unknown key, and scopes every lookup to the tenant', async () => {
      await expect(service.adopt(TENANT, 'nope', {})).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      notAdopted();
      await service.adopt(TENANT, 'patient_reengagement', {});
      for (const call of templates.findOne.mock.calls) {
        expect(call[0].where.tenant).toEqual({ id: TENANT });
      }
    });

    it('still saves a draft when the clinic has no usable account yet', async () => {
      notAdopted();
      accounts.find.mockResolvedValue([]);
      await service.adopt(TENANT, 'appointment_reminder_24h', {});
      expect(templates.save.mock.calls[0][0].whatsapp_account).toBeUndefined();
    });

    it('is audited without any template text or phone number', async () => {
      notAdopted();
      await service.adopt(TENANT, 'appointment_reminder_24h', {}, 'user-1');
      const entry = audit.record.mock.calls[0][0];
      expect(entry).toMatchObject({
        tenantId: TENANT,
        action: WHATSAPP_TEMPLATE_AUDIT_ACTION.LIBRARY_ADOPTED,
        actorUserId: 'user-1',
      });
      expect(JSON.stringify(entry)).not.toMatch(/\+966|مرحباً/);
    });
  });

  describe('list', () => {
    it('returns all six entries, attaching only this tenant’s copies', async () => {
      templates.find
        .mockResolvedValueOnce([
          {
            id: 'tpl-1',
            library_key: 'appointment_reminder_24h',
            library_version: 1,
          },
        ])
        .mockResolvedValueOnce([]);
      const res = await service.list(TENANT);

      expect(res).toHaveLength(6);
      expect(res.map((r) => r.key)).toEqual(TEMPLATE_LIBRARY.map((t) => t.key));
      expect(
        res.find((r) => r.key === 'appointment_reminder_24h')!.adopted,
      ).toMatchObject({ id: 'tpl-1' });
      expect(res.filter((r) => r.adopted)).toHaveLength(1);
      for (const call of templates.find.mock.calls)
        expect(call[0].where.tenant).toEqual({ id: TENANT });
    });

    it('flags an available update only when the catalog is newer than the copy', async () => {
      templates.find
        .mockResolvedValueOnce([
          {
            id: 'a',
            library_key: 'appointment_reminder_24h',
            library_version: 0,
          },
          { id: 'b', library_key: 'patient_reengagement', library_version: 1 },
        ])
        .mockResolvedValueOnce([]);
      const res = await service.list(TENANT);
      expect(
        res.find((r) => r.key === 'appointment_reminder_24h')!.update_available,
      ).toBe(true);
      expect(
        res.find((r) => r.key === 'patient_reengagement')!.update_available,
      ).toBe(false);
      expect(
        res.find((r) => r.key === 'clinic_special_offer')!.update_available,
      ).toBe(false);
    });

    it('warns about a name clash with a hand-made template', async () => {
      templates.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'x', name: 'patient_reengagement_ar', language: 'ar' },
        ]);
      const res = await service.list(TENANT);
      expect(
        res.find((r) => r.key === 'patient_reengagement')!.name_conflict,
      ).toBe(true);
      expect(
        res.find((r) => r.key === 'clinic_special_offer')!.name_conflict,
      ).toBe(false);
    });

    it('describes every placeholder, including the link button’s', async () => {
      templates.find.mockResolvedValue([]);
      const res = await service.list(TENANT);
      const confirmation = res.find(
        (r) => r.key === 'appointment_confirmation',
      )!;
      expect(confirmation.variables.map((v) => v.placeholder)).toEqual([
        '1',
        '2',
        '3',
        '4',
        'button_0',
      ]);
      expect(
        confirmation.variables.find((v) => v.placeholder === 'button_0')!
          .source,
      ).toBe('reschedule_token');
      const offer = res.find((r) => r.key === 'clinic_special_offer')!;
      expect(
        offer.variables.find((v) => v.placeholder === '3')!.source,
      ).toBeNull();
    });
  });

  describe('applyUpdate', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'tpl-1',
      name: 'appointment_reminder_24h',
      status: WHATSAPP_TEMPLATE_STATUS.DRAFT,
      library_key: 'appointment_reminder_24h',
      library_version: 0,
      provider_template_id: null,
      variable_mapping: { '1': 'patient_name' }, // the clinic chose differently from the catalog default
      components: {
        components: [
          {
            type: 'BUTTONS',
            buttons: [
              {
                type: 'PHONE_NUMBER',
                text: 'x',
                phone_number: '+966599999999',
              },
            ],
          },
        ],
      },
      whatsapp_account: { id: 'acc-1' },
      ...over,
    });

    it('re-copies the current revision onto a draft, keeping the clinic’s phone and its own bindings', async () => {
      templates.findOne.mockResolvedValue(row());
      await service.applyUpdate(TENANT, 'appointment_reminder_24h', 'user-1');
      const saved = templates.save.mock.calls[0][0];
      expect(saved.library_version).toBe(1);
      expect(saved.variable_mapping['1']).toBe('patient_name'); // not overwritten by the catalog default
      expect(saved.variable_mapping['2']).toBe('clinic_name'); // missing ones are added
      const phone = saved.components.components.find(
        (c: any) => c.type === 'BUTTONS',
      ).buttons[0];
      expect(phone.phone_number).toBe('+966599999999');
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: WHATSAPP_TEMPLATE_AUDIT_ACTION.LIBRARY_UPDATED,
      });
    });

    it.each(['pending_review', 'approved', 'rejected'])(
      'never touches a %s template',
      async (status) => {
        templates.findOne.mockResolvedValue(
          row({ status, provider_template_id: 'meta-1' }),
        );
        await expect(
          service.applyUpdate(TENANT, 'appointment_reminder_24h'),
        ).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          publicContext: { reason: 'NOT_A_DRAFT' },
        });
        expect(templates.save).not.toHaveBeenCalled();
      },
    );

    it('does nothing when already on the latest version', async () => {
      templates.findOne.mockResolvedValue(row({ library_version: 1 }));
      await expect(
        service.applyUpdate(TENANT, 'appointment_reminder_24h'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('404s a template this tenant never adopted', async () => {
      templates.findOne.mockResolvedValue(null);
      await expect(
        service.applyUpdate(TENANT, 'appointment_reminder_24h'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});
