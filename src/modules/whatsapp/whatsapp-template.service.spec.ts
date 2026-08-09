import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { MetaGraphClient } from './meta/meta-graph.client';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { WHATSAPP_TEMPLATE_STATUS } from './whatsapp.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

/** A minimal valid create payload: one BODY, no placeholders. */
const SIMPLE_BODY = [{ type: 'BODY', text: 'Your appointment is confirmed.' }];

/** The App Review demo template: BODY with two placeholders + examples. */
const REVIEW_BODY = [
  {
    type: 'BODY',
    text: 'Hello {{1}}, this is a reminder for your appointment on {{2}}.',
    example: ['Mohamed', '12 August 2026 at 5:00 PM'],
  },
];

describe('WhatsappTemplateService', () => {
  let service: WhatsappTemplateService;
  let templates: MockRepository;
  let accounts: MockRepository;
  let graph: { createTemplate: jest.Mock };
  let resolver: { byId: jest.Mock; forTenant: jest.Mock };

  beforeEach(async () => {
    templates = createMockRepository();
    accounts = createMockRepository();
    accounts.exists.mockResolvedValue(true);

    graph = {
      createTemplate: jest.fn().mockResolvedValue({
        id: 'meta-tpl-1',
        status: 'PENDING',
        category: 'UTILITY',
      }),
    };
    // A connected account with a WABA + decrypted token, exactly as the real
    // resolver returns it.
    resolver = {
      byId: jest.fn().mockResolvedValue({
        id: 'acc-1',
        wabaId: 'waba-1',
        accessToken: 'tok-1',
      }),
      forTenant: jest.fn().mockResolvedValue({
        id: 'acc-1',
        wabaId: 'waba-1',
        accessToken: 'tok-1',
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappTemplateService,
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: MetaGraphClient, useValue: graph },
        { provide: WhatsappAccountResolver, useValue: resolver },
      ],
    }).compile();
    service = moduleRef.get(WhatsappTemplateService);
  });

  afterEach(() => jest.clearAllMocks());

  // ───────────────────────── create → Meta → mirror ─────────────────────────

  describe('create submits to Meta before persisting anything', () => {
    it('creates on Meta and mirrors the response', async () => {
      templates.findOne.mockResolvedValueOnce(null); // no duplicate
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => ({ ...t, id: 'tpl1' }));

      const res = await service.create(TENANT, {
        name: 'appointment_reminder_review_test',
        language: 'en_US',
        category: 'UTILITY',
        components: REVIEW_BODY,
      } as any);

      expect(graph.createTemplate).toHaveBeenCalledWith('waba-1', 'tok-1', {
        name: 'appointment_reminder_review_test',
        language: 'en_US',
        category: 'UTILITY',
        components: [
          {
            type: 'BODY',
            text: 'Hello {{1}}, this is a reminder for your appointment on {{2}}.',
            example: { body_text: [['Mohamed', '12 August 2026 at 5:00 PM']] },
          },
        ],
      });
      expect(res).toMatchObject({
        provider_template_id: 'meta-tpl-1',
        waba_id: 'waba-1',
        status: WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW,
      });
    });

    it('persists NOTHING when Meta rejects the template', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      graph.createTemplate.mockRejectedValueOnce(
        Object.assign(new Error('Meta rejected the request'), {
          code: ErrorCode.UNPROCESSABLE_ENTITY,
        }),
      );

      await expect(
        service.create(TENANT, {
          name: 'bad_template',
          language: 'en_US',
          category: 'UTILITY',
          components: SIMPLE_BODY,
        } as any),
      ).rejects.toThrow();

      // The whole point of calling Meta first: no misleading local draft.
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('refuses to create when the tenant has no connected WABA', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      resolver.forTenant.mockResolvedValueOnce({ id: 'acc-1', wabaId: undefined, accessToken: undefined });

      await expect(
        service.create(TENANT, {
          name: 'x_template',
          language: 'en_US',
          category: 'UTILITY',
          components: SIMPLE_BODY,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('rejects a duplicate name+language before calling Meta', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(
        service.create(TENANT, {
          name: 'welcome',
          language: 'en_US',
          category: 'UTILITY',
          components: SIMPLE_BODY,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects an account not in the tenant with 422, before calling Meta', async () => {
      accounts.exists.mockResolvedValueOnce(false);
      await expect(
        service.create(TENANT, {
          name: 'x_template',
          language: 'en_US',
          category: 'UTILITY',
          accountId: 'bad',
          components: SIMPLE_BODY,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('uses the explicitly named account, resolved tenant-scoped', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);

      await service.create(TENANT, {
        name: 'x_template',
        language: 'ar',
        category: 'UTILITY',
        accountId: 'acc-9',
        components: SIMPLE_BODY,
      } as any);

      // Tenant id is always the first argument — a caller cannot reach another
      // tenant's account by naming its id.
      expect(resolver.byId).toHaveBeenCalledWith(TENANT, 'acc-9');
      expect(resolver.forTenant).not.toHaveBeenCalled();
    });

    it("prefers Meta's category when Meta re-categorises the template", async () => {
      templates.findOne.mockResolvedValueOnce(null);
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);
      graph.createTemplate.mockResolvedValueOnce({
        id: 'meta-tpl-2',
        status: 'PENDING',
        category: 'MARKETING',
      });

      const res = await service.create(TENANT, {
        name: 'promo_template',
        language: 'en_US',
        category: 'UTILITY',
        components: SIMPLE_BODY,
      } as any);

      expect(res.category).toBe('MARKETING');
    });
  });

  // ──────────────────────── component structure rules ───────────────────────

  describe('component validation (the rules Meta would otherwise reject opaquely)', () => {
    const create = (components: unknown) =>
      service.create(TENANT, {
        name: 'x_template',
        language: 'en_US',
        category: 'UTILITY',
        components,
      } as any);

    beforeEach(() => templates.findOne.mockResolvedValue(null));

    it('requires exactly one BODY', async () => {
      await expect(create([{ type: 'FOOTER', text: 'Bye' }])).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      await expect(
        create([
          { type: 'BODY', text: 'a' },
          { type: 'BODY', text: 'b' },
        ]),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects placeholders with no example values', async () => {
      await expect(
        create([{ type: 'BODY', text: 'Hello {{1}}, see you on {{2}}.' }]),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects an example count that does not match the placeholder count', async () => {
      await expect(
        create([
          { type: 'BODY', text: 'Hello {{1}}, see you on {{2}}.', example: ['Mohamed'] },
        ]),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects a component text that is blank', async () => {
      await expect(create([{ type: 'BODY', text: '   ' }])).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects a URL button with no url', async () => {
      await expect(
        create([
          ...SIMPLE_BODY,
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open' }] },
        ]),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('maps a HEADER example to Meta\'s flat header_text shape', async () => {
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);

      await create([
        { type: 'HEADER', text: 'Reminder for {{1}}', example: ['Mohamed'] },
        ...SIMPLE_BODY,
      ]);

      const sent = graph.createTemplate.mock.calls[0][2];
      expect(sent.components[0]).toMatchObject({
        type: 'HEADER',
        format: 'TEXT',
        example: { header_text: ['Mohamed'] },
      });
    });

    it('passes quick-reply buttons through unchanged', async () => {
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);

      await create([
        ...SIMPLE_BODY,
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }] },
      ]);

      const sent = graph.createTemplate.mock.calls[0][2];
      expect(sent.components[1]).toEqual({
        type: 'BUTTONS',
        buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }],
      });
    });
  });

  // ─────────────────── GAP-002: centralized transition guard ────────────────

  describe('GAP-002 — `approved` is reachable only from Meta', () => {
    it('setStatus refuses to set APPROVED directly', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: 'PENDING_REVIEW' });
      await expect(
        service.setStatus(TENANT, 'tpl1', WHATSAPP_TEMPLATE_STATUS.APPROVED),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('update() refuses to set APPROVED directly', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: 'PENDING_REVIEW' });
      await expect(
        service.update(TENANT, 'tpl1', { status: WHATSAPP_TEMPLATE_STATUS.APPROVED } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('create() ignores a smuggled `status` — the stored status is Meta\'s', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);

      // `status` is not on CreateWhatsappTemplateDto at all (the global
      // ValidationPipe's forbidNonWhitelisted would already 400 it over HTTP).
      // Even reaching the service directly with it, it cannot influence the row.
      const res = await service.create(TENANT, {
        name: 'sneaky_template',
        language: 'en_US',
        category: 'UTILITY',
        components: SIMPLE_BODY,
        status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
      } as any);

      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });

    it('an APPROVED template from Meta IS stored as approved', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);
      graph.createTemplate.mockResolvedValueOnce({ id: 'm2', status: 'APPROVED' });

      const res = await service.create(TENANT, {
        name: 'auto_approved',
        language: 'en_US',
        category: 'UTILITY',
        components: SIMPLE_BODY,
      } as any);

      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.APPROVED);
    });

    it('an UNKNOWN Meta status is never treated as sendable', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);
      graph.createTemplate.mockResolvedValueOnce({ id: 'm3', status: 'SOME_NEW_META_STATUS' });

      const res = await service.create(TENANT, {
        name: 'unknown_status',
        language: 'en_US',
        category: 'UTILITY',
        components: SIMPLE_BODY,
      } as any);

      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });
  });

  it('getSendableTemplate requires APPROVED status', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: WHATSAPP_TEMPLATE_STATUS.DRAFT });
    await expect(service.getSendableTemplate(TENANT, 'tpl1')).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });

    templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: WHATSAPP_TEMPLATE_STATUS.APPROVED });
    await expect(service.getSendableTemplate(TENANT, 'tpl1')).resolves.toMatchObject({ id: 'tpl1' });
  });

  it('remove soft-removes the template', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1' });
    await service.remove(TENANT, 'tpl1');
    expect(templates.softRemove).toHaveBeenCalled();
  });

  it('setStatus applies a valid, tenant-settable status', async () => {
    templates.findOne.mockResolvedValueOnce({ id: 'tpl1', status: 'DRAFT' });
    templates.save.mockImplementationOnce(async (t: any) => t);
    const res = await service.setStatus(TENANT, 'tpl1', WHATSAPP_TEMPLATE_STATUS.DISABLED);
    expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.DISABLED);
  });

  it('setStatus rejects an invalid status', async () => {
    await expect(service.setStatus(TENANT, 'tpl1', 'bogus')).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
    });
  });
});
