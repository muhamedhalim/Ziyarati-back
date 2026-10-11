import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { NotificationTemplateService } from './notification-template.service';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import { AppError, ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

/** A WhatsApp template exactly as the mirror stores it once Meta approved it. */
const approvedTemplate = (over: Record<string, unknown> = {}) => ({
  id: 'wa-x',
  name: 'appointment_reminder',
  language: 'en',
  status: 'approved',
  components: { components: [{ type: 'BODY', text: 'Hello {{1}}, see you on {{2}} at the clinic.' }] },
  variable_mapping: { '1': 'patient_name', '2': 'appointment_date' },
  ...over,
});

describe('NotificationTemplateService', () => {
  let service: NotificationTemplateService;
  let templates: MockRepository;
  let rules: MockRepository;
  let scheduled: MockRepository;
  let whatsappTemplates: { findOne: jest.Mock };

  beforeEach(async () => {
    templates = createMockRepository();
    rules = createMockRepository();
    scheduled = createMockRepository();
    whatsappTemplates = { findOne: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationTemplateService,
        { provide: getRepositoryToken(NotificationTemplate), useValue: templates },
        { provide: getRepositoryToken(NotificationRule), useValue: rules },
        { provide: getRepositoryToken(ScheduledNotification), useValue: scheduled },
        { provide: WhatsappTemplateService, useValue: whatsappTemplates },
      ],
    }).compile();
    service = moduleRef.get(NotificationTemplateService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a template', async () => {
    templates.save.mockResolvedValueOnce({ id: 'tpl1' });
    await expect(service.create(TENANT, { name: 'Reminder', channel: 'WHATSAPP' } as any)).resolves.toEqual({ id: 'tpl1' });
  });

  it('findOne throws for an unknown template', async () => {
    templates.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('updates and toggles active', async () => {
    templates.findOne.mockResolvedValue({ id: 'tpl1', is_active: true });
    templates.save.mockImplementation(async (t: any) => t);
    await service.update(TENANT, 'tpl1', { name: 'New' } as any);
    expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }));
    await service.setActive(TENANT, 'tpl1', false);
    expect(templates.save).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
  });

  it('blocks deleting a template that is still referenced', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
    rules.count.mockResolvedValueOnce(1);
    scheduled.count.mockResolvedValueOnce(0);
    await expect(service.remove(TENANT, 'tpl1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('deletes an unreferenced template', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
    rules.count.mockResolvedValueOnce(0);
    scheduled.count.mockResolvedValueOnce(0);
    await service.remove(TENANT, 'tpl1');
    expect(templates.delete).toHaveBeenCalledWith({ id: 'tpl1' });
  });

  // ── T157 gap-closure: provider_template_id had NO write path at all before
  // this fix — every WhatsApp automated dispatch permanently failed
  // regardless of language. These prove the (now-fixed) write path AND the
  // new Arabic-variant link that makes locale-based selection possible.
  describe('[T157] provider_template_id / provider_template_id_ar', () => {
    it('validates and persists providerTemplateId (tenant-owned WhatsApp template)', async () => {
      whatsappTemplates.findOne.mockResolvedValueOnce(approvedTemplate({ id: 'wa-1', language: 'en' }));
      templates.save.mockImplementationOnce(async (t: any) => t);
      const res = await service.create(TENANT, {
        name: 'Reminder',
        channel: 'WHATSAPP',
        providerTemplateId: 'wa-1',
      } as any);
      expect(whatsappTemplates.findOne).toHaveBeenCalledWith(TENANT, 'wa-1');
      expect(res).toEqual(expect.objectContaining({ provider_template_id: 'wa-1' }));
    });

    it('validates and persists providerTemplateIdAr when its WhatsApp template is Arabic', async () => {
      whatsappTemplates.findOne.mockResolvedValueOnce(approvedTemplate({ id: 'wa-2', language: 'ar' }));
      templates.save.mockImplementationOnce(async (t: any) => t);
      const res = await service.create(TENANT, {
        name: 'Reminder',
        channel: 'WHATSAPP',
        providerTemplateIdAr: 'wa-2',
      } as any);
      expect(res).toEqual(expect.objectContaining({ provider_template_id_ar: 'wa-2' }));
    });

    it('rejects providerTemplateIdAr when the linked template is not actually Arabic', async () => {
      whatsappTemplates.findOne.mockResolvedValueOnce({ id: 'wa-3', language: 'en' });
      await expect(
        service.create(TENANT, {
          name: 'Reminder',
          channel: 'WHATSAPP',
          providerTemplateIdAr: 'wa-3',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('rejects a providerTemplateId that does not belong to this tenant', async () => {
      whatsappTemplates.findOne.mockRejectedValueOnce(
        new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' }),
      );
      await expect(
        service.create(TENANT, {
          name: 'Reminder',
          channel: 'WHATSAPP',
          providerTemplateId: 'not-mine',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('updates providerTemplateId/providerTemplateIdAr on an existing template', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
      whatsappTemplates.findOne
        .mockResolvedValueOnce(approvedTemplate({ id: 'wa-1', language: 'en' }))
        .mockResolvedValueOnce(approvedTemplate({ id: 'wa-2', language: 'ar' }));
      templates.save.mockImplementationOnce(async (t: any) => t);
      const res = await service.update(TENANT, 'tpl1', {
        providerTemplateId: 'wa-1',
        providerTemplateIdAr: 'wa-2',
      } as any);
      expect(res).toEqual(
        expect.objectContaining({ provider_template_id: 'wa-1', provider_template_id_ar: 'wa-2' }),
      );
    });

    // ── Readiness: the link is the clinic's explicit "this event uses this
    // template", so it must point at something that can actually be sent.
    describe('readiness at link time', () => {
      it.each(['pending_review', 'rejected', 'paused', 'disabled', 'draft'])(
        'refuses a %s template',
        async (status) => {
          whatsappTemplates.findOne.mockResolvedValueOnce(approvedTemplate({ status }));
          await expect(
            service.create(TENANT, { name: 'R', channel: 'WHATSAPP', providerTemplateId: 'wa-x' } as any),
          ).rejects.toMatchObject({
            code: ErrorCode.UNPROCESSABLE_ENTITY,
            publicContext: { reason: 'TEMPLATE_NOT_APPROVED' },
          });
          expect(templates.save).not.toHaveBeenCalled();
        },
      );

      it('refuses an approved template whose placeholders have no data source', async () => {
        whatsappTemplates.findOne.mockResolvedValueOnce(
          approvedTemplate({ variable_mapping: { '1': 'patient_name' } }),
        );
        await expect(
          service.create(TENANT, { name: 'R', channel: 'WHATSAPP', providerTemplateId: 'wa-x' } as any),
        ).rejects.toMatchObject({
          publicContext: { reason: 'UNBOUND_PLACEHOLDERS', placeholders: ['2'] },
        });
      });

      it('accepts an approved template with no placeholders and no mapping', async () => {
        whatsappTemplates.findOne.mockResolvedValueOnce(
          approvedTemplate({
            components: { components: [{ type: 'BODY', text: 'Your appointment is confirmed.' }] },
            variable_mapping: null,
          }),
        );
        templates.save.mockImplementationOnce(async (t: any) => t);
        await expect(
          service.create(TENANT, { name: 'R', channel: 'WHATSAPP', providerTemplateId: 'wa-x' } as any),
        ).resolves.toMatchObject({ provider_template_id: 'wa-x' });
      });

      it('refuses a template shape the platform cannot fill', async () => {
        whatsappTemplates.findOne.mockResolvedValueOnce(
          approvedTemplate({
            components: {
              components: [
                { type: 'HEADER', format: 'IMAGE' },
                { type: 'BODY', text: 'Hi there, your appointment is confirmed.' },
              ],
            },
            variable_mapping: null,
          }),
        );
        await expect(
          service.create(TENANT, { name: 'R', channel: 'WHATSAPP', providerTemplateId: 'wa-x' } as any),
        ).rejects.toMatchObject({ publicContext: { reason: 'UNSUPPORTED_TEMPLATE_SHAPE' } });
      });

      it('does not re-judge an UNCHANGED link on an unrelated edit (a later pause must not block renaming)', async () => {
        templates.findOne.mockResolvedValueOnce({ id: 'tpl1', provider_template_id: 'wa-x' });
        whatsappTemplates.findOne.mockResolvedValueOnce(approvedTemplate({ status: 'paused' }));
        templates.save.mockImplementationOnce(async (t: any) => t);

        const res = await service.update(TENANT, 'tpl1', {
          name: 'Renamed',
          providerTemplateId: 'wa-x',
        } as any);
        expect(res).toMatchObject({ name: 'Renamed', provider_template_id: 'wa-x' });
      });

      it('DOES judge a link that changes to a different template', async () => {
        templates.findOne.mockResolvedValueOnce({ id: 'tpl1', provider_template_id: 'wa-old' });
        whatsappTemplates.findOne.mockResolvedValueOnce(approvedTemplate({ status: 'rejected' }));
        await expect(
          service.update(TENANT, 'tpl1', { providerTemplateId: 'wa-x' } as any),
        ).rejects.toMatchObject({ publicContext: { reason: 'TEMPLATE_NOT_APPROVED' } });
      });
    });
  });
});
