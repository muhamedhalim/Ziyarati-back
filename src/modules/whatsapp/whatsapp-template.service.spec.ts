import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { MetaGraphClient } from './meta/meta-graph.client';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { WHATSAPP_TEMPLATE_STATUS } from './whatsapp.constants';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

/** A minimal valid create payload: one BODY, no placeholders. */
const SIMPLE_BODY = [
  { type: 'BODY', text: 'Your appointment has been confirmed. We look forward to seeing you soon.' },
];

/** The App Review demo template: BODY with two placeholders + examples. */
const REVIEW_BODY = [
  {
    type: 'BODY',
    text: 'Hello {{1}}, this is a reminder for your appointment on {{2}}.',
    example: ['Mohamed', '12 August 2026 at 5:00 PM'],
  },
];

/** A Meta-originated failure shaped exactly like MetaGraphClient throws. */
function metaError(meta: Record<string, unknown>, message = 'Meta rejected the request') {
  return new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
    message,
    publicContext: { meta },
    internalContext: { metaCode: meta.metaCode, metaSubcode: meta.metaSubcode, httpStatus: meta.httpStatus },
  });
}

describe('WhatsappTemplateService', () => {
  let service: WhatsappTemplateService;
  let templates: MockRepository;
  let accounts: MockRepository;
  let notificationTemplates: MockRepository;
  let graph: {
    createTemplate: jest.Mock;
    getTemplate: jest.Mock;
    findTemplatesByName: jest.Mock;
    deleteTemplate: jest.Mock;
  };
  let resolver: { byId: jest.Mock; forTenant: jest.Mock };

  beforeEach(async () => {
    templates = createMockRepository();
    accounts = createMockRepository();
    accounts.exists.mockResolvedValue(true);
    notificationTemplates = createMockRepository();
    const nqb = createMockQueryBuilder();
    nqb.getCount.mockResolvedValue(0);
    notificationTemplates.createQueryBuilder.mockReturnValue(nqb);

    graph = {
      createTemplate: jest.fn().mockResolvedValue({
        id: 'meta-tpl-1',
        status: 'PENDING',
        category: 'UTILITY',
      }),
      getTemplate: jest.fn(),
      findTemplatesByName: jest.fn(),
      deleteTemplate: jest.fn().mockResolvedValue(undefined),
    };
    // A connected account with a WABA + decrypted token, exactly as the real
    // resolver returns it.
    resolver = {
      byId: jest.fn().mockResolvedValue({ id: 'acc-1', wabaId: 'waba-1', accessToken: 'tok-1' }),
      forTenant: jest.fn().mockResolvedValue({ id: 'acc-1', wabaId: 'waba-1', accessToken: 'tok-1' }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappTemplateService,
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(NotificationTemplate), useValue: notificationTemplates },
        { provide: MetaGraphClient, useValue: graph },
        { provide: WhatsappAccountResolver, useValue: resolver },
      ],
    }).compile();
    service = moduleRef.get(WhatsappTemplateService);
  });

  afterEach(() => jest.clearAllMocks());

  const baseDto = (over: Record<string, unknown> = {}) =>
    ({
      name: 'x_template',
      language: 'en_US',
      category: 'UTILITY',
      components: SIMPLE_BODY,
      ...over,
    }) as any;

  /** First findOne (duplicate lookup) returns nothing; create/save echo the row. */
  const happyPersistence = () => {
    templates.findOne.mockResolvedValueOnce(null);
    templates.create.mockImplementationOnce((t: any) => t);
    templates.save.mockImplementationOnce(async (t: any) => ({ ...t, id: 'tpl1' }));
  };

  // ───────────────────────── create → Meta → mirror ─────────────────────────

  describe('create submits to Meta before persisting anything', () => {
    it('creates a no-variable template on Meta and mirrors the response', async () => {
      happyPersistence();
      const res = await service.create(TENANT, baseDto());

      expect(graph.createTemplate).toHaveBeenCalledWith('waba-1', 'tok-1', {
        name: 'x_template',
        language: 'en_US',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: SIMPLE_BODY[0].text }],
      });
      expect(res).toMatchObject({
        provider_template_id: 'meta-tpl-1',
        waba_id: 'waba-1',
        status: WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW,
      });
    });

    it('creates a template with variables and sends Meta the nested body_text example', async () => {
      happyPersistence();
      const res = await service.create(
        TENANT,
        baseDto({ name: 'appointment_reminder_review_test', components: REVIEW_BODY }),
      );

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
      expect(res.components).toMatchObject({ parameter_format: 'POSITIONAL' });
    });

    it('persists NOTHING when Meta rejects the template, and keeps Meta’s own words', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      graph.createTemplate.mockRejectedValueOnce(
        metaError({
          kind: 'rejected',
          retriable: false,
          metaCode: 100,
          metaMessage: 'Invalid parameter',
          metaDetail: 'This template has too many variables for its length.',
        }),
      );

      const err = await service.create(TENANT, baseDto()).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.publicContext.meta.metaDetail).toMatch(/too many variables/);
      // The whole point of calling Meta first: no misleading local draft.
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('refuses to create when the tenant has no connected WABA', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      resolver.forTenant.mockResolvedValueOnce({ id: 'acc-1', wabaId: undefined, accessToken: undefined });

      await expect(service.create(TENANT, baseDto())).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(graph.createTemplate).not.toHaveBeenCalled();
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('rejects a duplicate name+language before calling Meta', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(TENANT, baseDto({ name: 'welcome' }))).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('revives a soft-deleted row with the same key instead of colliding with it', async () => {
      const tombstone = { id: 'old', name: 'x_template', language: 'en_US', deleted_at: new Date() };
      templates.findOne.mockResolvedValueOnce(tombstone);
      templates.save.mockImplementationOnce(async (t: any) => t);

      const res = await service.create(TENANT, baseDto());

      expect(templates.create).not.toHaveBeenCalled();
      expect(res.id).toBe('old');
      expect(res.deleted_at).toBeNull();
      expect(res.provider_template_id).toBe('meta-tpl-1');
    });

    it('rejects an account not in the tenant with 422, before calling Meta', async () => {
      accounts.exists.mockResolvedValueOnce(false);
      await expect(service.create(TENANT, baseDto({ accountId: 'bad' }))).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('uses the explicitly named account, resolved tenant-scoped', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);

      await service.create(TENANT, baseDto({ language: 'ar', accountId: 'acc-9' }));

      // Tenant id is always the first argument — a caller cannot reach another
      // tenant's account by naming its id.
      expect(resolver.byId).toHaveBeenCalledWith(TENANT, 'acc-9');
      expect(resolver.forTenant).not.toHaveBeenCalled();
    });

    it("prefers Meta's category when Meta re-categorises the template", async () => {
      happyPersistence();
      graph.createTemplate.mockResolvedValueOnce({ id: 'meta-tpl-2', status: 'PENDING', category: 'MARKETING' });

      const res = await service.create(TENANT, baseDto({ name: 'promo_template' }));
      expect(res.category).toBe('MARKETING');
    });
  });

  // ─────────────────── pre-submission validation (the bug) ──────────────────

  describe('pre-submission validation', () => {
    beforeEach(() => templates.findOne.mockResolvedValue(null));

    it('blocks a body whose placeholders skip a number — Meta is never called', async () => {
      const err = await service
        .create(
          TENANT,
          baseDto({
            components: [
              {
                type: 'BODY',
                text: 'Hello {{1}}, your appointment is confirmed for {{3}} at the clinic today.',
                example: ['Sara', 'Sunday'],
              },
            ],
          }),
        )
        .catch((e) => e);

      expect(err.code).toBe(ErrorCode.UNPROCESSABLE_ENTITY);
      expect(err.publicContext.validation.issues.map((i: any) => i.code)).toContain('VARIABLE_ORDER');
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('blocks a body that starts/ends with a placeholder, naming the field', async () => {
      const err = await service
        .create(
          TENANT,
          baseDto({ components: [{ type: 'BODY', text: '{{1}} is confirmed for tomorrow', example: ['Sara'] }] }),
        )
        .catch((e) => e);
      const issue = err.publicContext.validation.issues.find((i: any) => i.code === 'VARIABLE_AT_START');
      expect(issue).toMatchObject({ field: 'body', severity: 'error' });
      expect(issue.suggestion).toBeTruthy();
    });

    it('does NOT block on variable density (heuristic) — submits and lets Meta decide', async () => {
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);
      await service.create(
        TENANT,
        baseDto({
          components: [{ type: 'BODY', text: 'Hi {{1}} visit {{2}} at {{3}} ok', example: ['a', 'b', 'c'] }],
        }),
      );
      expect(graph.createTemplate).toHaveBeenCalledTimes(1);
    });

    it('rejects placeholders with no example values', async () => {
      await expect(
        service.create(
          TENANT,
          baseDto({ components: [{ type: 'BODY', text: 'Hello {{1}}, see you on {{2}} at the clinic soon.' }] }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects a header placeholder (this platform cannot fill header parameters)', async () => {
      const err = await service
        .create(
          TENANT,
          baseDto({
            components: [{ type: 'HEADER', text: 'Reminder for {{1}}', example: ['Mohamed'] }, ...SIMPLE_BODY],
          }),
        )
        .catch((e) => e);
      expect(err.publicContext.validation.issues.map((i: any) => i.code)).toContain(
        'HEADER_VARIABLE_UNSUPPORTED',
      );
    });

    it('requires exactly one BODY and a non-blank text', async () => {
      await expect(
        service.create(TENANT, baseDto({ components: [{ type: 'FOOTER', text: 'Bye' }] })),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      await expect(
        service.create(TENANT, baseDto({ components: [{ type: 'BODY', text: '   ' }] })),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('rejects a URL button with no url', async () => {
      await expect(
        service.create(
          TENANT,
          baseDto({ components: [...SIMPLE_BODY, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open' }] }] }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('passes quick-reply buttons through unchanged', async () => {
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);

      await service.create(
        TENANT,
        baseDto({
          components: [...SIMPLE_BODY, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }] }],
        }),
      );
      const sent = graph.createTemplate.mock.calls[0][2];
      expect(sent.components[1]).toEqual({
        type: 'BUTTONS',
        buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }],
      });
    });

    it('validate() is a pure dry-run: no Meta call, no write', () => {
      const r = service.validate({ components: REVIEW_BODY as any });
      expect(r.valid).toBe(true);
      expect(graph.createTemplate).not.toHaveBeenCalled();
      expect(templates.save).not.toHaveBeenCalled();
    });
  });

  describe('create with a variable binding', () => {
    it('stores the placeholder → source map on the mirror row', async () => {
      happyPersistence();
      const res = await service.create(
        TENANT,
        baseDto({
          components: REVIEW_BODY,
          variableMapping: { '1': 'patient_name', '2': 'appointment_date' },
        }),
      );
      expect(res.variable_mapping).toEqual({ '1': 'patient_name', '2': 'appointment_date' });
    });

    it('refuses an unknown source BEFORE anything is sent to Meta', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(
          TENANT,
          baseDto({ components: REVIEW_BODY, variableMapping: { '1': 'customer.phone' } }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('refuses a binding for a placeholder the body does not declare', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create(
          TENANT,
          baseDto({ components: REVIEW_BODY, variableMapping: { '7': 'patient_name' } }),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });
  });

  // ─────────────── ambiguous outcomes, duplicates, double submit ────────────

  describe('create failure handling', () => {
    beforeEach(() => templates.findOne.mockResolvedValue(null));

    it('adopts the template when a timeout hid a SUCCESSFUL create', async () => {
      templates.create.mockImplementationOnce((t: any) => t);
      templates.save.mockImplementationOnce(async (t: any) => t);
      graph.createTemplate.mockRejectedValueOnce(metaError({ kind: 'timeout', retriable: true }));
      graph.findTemplatesByName.mockResolvedValueOnce([
        { id: 'meta-9', name: 'x_template', language: 'en_US', status: 'PENDING', category: 'UTILITY' },
      ]);

      const res = await service.create(TENANT, baseDto());

      expect(graph.createTemplate).toHaveBeenCalledTimes(1); // never re-POSTed
      expect(res.provider_template_id).toBe('meta-9');
      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });

    it('says "outcome unknown — do not resubmit" when the lookup also fails', async () => {
      graph.createTemplate.mockRejectedValueOnce(metaError({ kind: 'network', retriable: true }));
      graph.findTemplatesByName.mockRejectedValueOnce(new Error('still down'));

      const err = await service.create(TENANT, baseDto()).catch((e) => e);
      expect(err.publicContext.meta).toMatchObject({ outcomeUnknown: true, retriable: true });
      expect(err.message).toMatch(/do not submit it again/i);
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('reports a timeout that really did not create as unknown rather than inventing a row', async () => {
      graph.createTemplate.mockRejectedValueOnce(metaError({ kind: 'timeout', retriable: true }));
      graph.findTemplatesByName.mockResolvedValueOnce([]);
      await expect(service.create(TENANT, baseDto())).rejects.toMatchObject({
        publicContext: { meta: { outcomeUnknown: true } },
      });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('maps Meta’s duplicate-content error to 409', async () => {
      graph.createTemplate.mockRejectedValueOnce(
        metaError({ kind: 'rejected', retriable: false, metaCode: 100, metaSubcode: 2388024 }),
      );
      await expect(service.create(TENANT, baseDto())).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('does not retry or reconcile a plain rejection', async () => {
      graph.createTemplate.mockRejectedValueOnce(
        metaError({ kind: 'rejected', retriable: false, metaCode: 100 }),
      );
      await expect(service.create(TENANT, baseDto())).rejects.toBeInstanceOf(AppError);
      expect(graph.findTemplatesByName).not.toHaveBeenCalled();
    });

    it('collapses a concurrent double submit onto ONE Meta call', async () => {
      templates.create.mockImplementation((t: any) => t);
      templates.save.mockImplementation(async (t: any) => ({ ...t, id: 'tpl1' }));
      let release!: () => void;
      graph.createTemplate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ id: 'meta-1', status: 'PENDING', category: 'UTILITY' });
          }),
      );

      const first = service.create(TENANT, baseDto());
      const second = service.create(TENANT, baseDto());
      await new Promise((r) => setImmediate(r));
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(graph.createTemplate).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });
  });

  // ───────────────────────────── refresh status ─────────────────────────────

  describe('refresh', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'tpl1',
      name: 'x_template',
      language: 'en_US',
      status: WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW,
      provider_template_id: 'meta-1',
      waba_id: 'waba-1',
      rejected_reason: 'OLD',
      whatsapp_account: { id: 'acc-1' },
      last_synced_at: new Date('2026-01-01'),
      ...over,
    });

    it('applies Meta’s verdict, clears a stale reason, and stamps the sync time', async () => {
      const r = row();
      templates.findOne.mockResolvedValueOnce(r).mockResolvedValueOnce({ ...r, status: 'approved' });
      templates.save.mockImplementationOnce(async (t: any) => t);
      graph.getTemplate.mockResolvedValueOnce({
        id: 'meta-1', name: 'x_template', language: 'en_US', status: 'APPROVED',
        category: 'UTILITY', rejectedReason: 'NONE', components: [{ type: 'BODY', text: 'hi' }],
      });

      await service.refresh(TENANT, 'tpl1');

      expect(graph.getTemplate).toHaveBeenCalledWith('meta-1', 'tok-1');
      const saved = templates.save.mock.calls[0][0];
      expect(saved.status).toBe('approved');
      expect(saved.rejected_reason).toBeNull();
      expect(saved.last_synced_at.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
    });

    it('records the rejection reason Meta gives', async () => {
      templates.findOne.mockResolvedValueOnce(row()).mockResolvedValueOnce(row());
      templates.save.mockImplementationOnce(async (t: any) => t);
      graph.getTemplate.mockResolvedValueOnce({
        id: 'meta-1', name: 'x_template', language: 'en_US', status: 'REJECTED', rejectedReason: 'INVALID_FORMAT',
      });
      await service.refresh(TENANT, 'tpl1');
      expect(templates.save.mock.calls[0][0]).toMatchObject({
        status: 'rejected',
        rejected_reason: 'INVALID_FORMAT',
      });
    });

    it('leaves the row EXACTLY as it was when Meta cannot be reached', async () => {
      templates.findOne.mockResolvedValueOnce(row());
      graph.getTemplate.mockRejectedValueOnce(metaError({ kind: 'timeout', retriable: true }));

      await expect(service.refresh(TENANT, 'tpl1')).rejects.toMatchObject({
        publicContext: { meta: { kind: 'timeout', retriable: true } },
      });
      expect(templates.save).not.toHaveBeenCalled();
      expect(templates.softRemove).not.toHaveBeenCalled();
    });

    it('removes the row only on a definite "gone on Meta"', async () => {
      templates.findOne.mockResolvedValueOnce(row());
      graph.getTemplate.mockResolvedValueOnce(null);
      await expect(service.refresh(TENANT, 'tpl1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(templates.softRemove).toHaveBeenCalled();
    });

    it('refuses to read a template through a token from a different WABA', async () => {
      templates.findOne.mockResolvedValueOnce(row({ waba_id: 'waba-OTHER' }));
      await expect(service.refresh(TENANT, 'tpl1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        publicContext: { reason: 'WABA_MISMATCH' },
      });
      expect(graph.getTemplate).not.toHaveBeenCalled();
    });

    it('has nothing to refresh for a template never submitted to Meta', async () => {
      templates.findOne.mockResolvedValueOnce(row({ provider_template_id: null }));
      await expect(service.refresh(TENANT, 'tpl1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(graph.getTemplate).not.toHaveBeenCalled();
    });

    it('is tenant-scoped: another tenant’s template id is a 404', async () => {
      templates.findOne.mockResolvedValueOnce(null);
      await expect(service.refresh('other-tenant', 'tpl1')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(templates.findOne.mock.calls[0][0].where).toMatchObject({
        id: 'tpl1',
        tenant: { id: 'other-tenant' },
      });
      expect(graph.getTemplate).not.toHaveBeenCalled();
    });
  });

  // ─────────────────── GAP-002: centralized transition guard ────────────────

  describe('GAP-002 — `approved` is reachable only from Meta', () => {
    it('setStatus refuses to set APPROVED directly', async () => {
      await expect(
        service.setStatus(TENANT, 'tpl1', WHATSAPP_TEMPLATE_STATUS.APPROVED),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('update() refuses to set APPROVED directly', async () => {
      await expect(
        service.update(TENANT, 'tpl1', { status: WHATSAPP_TEMPLATE_STATUS.APPROVED } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('create() ignores a smuggled `status` — the stored status is Meta\'s', async () => {
      happyPersistence();
      const res = await service.create(
        TENANT,
        baseDto({ name: 'sneaky_template', status: WHATSAPP_TEMPLATE_STATUS.APPROVED }),
      );
      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });

    it('an APPROVED template from Meta IS stored as approved', async () => {
      happyPersistence();
      graph.createTemplate.mockResolvedValueOnce({ id: 'm2', status: 'APPROVED' });
      const res = await service.create(TENANT, baseDto({ name: 'auto_approved' }));
      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.APPROVED);
    });

    it('an UNKNOWN Meta status is never treated as sendable', async () => {
      happyPersistence();
      graph.createTemplate.mockResolvedValueOnce({ id: 'm3', status: 'SOME_NEW_META_STATUS' });
      const res = await service.create(TENANT, baseDto({ name: 'unknown_status' }));
      expect(res.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });
  });

  // ─────────────────────────── sendability gate ─────────────────────────────

  describe('getSendableTemplate', () => {
    const tpl = (over: Record<string, unknown> = {}) => ({
      id: 'tpl1',
      status: WHATSAPP_TEMPLATE_STATUS.APPROVED,
      waba_id: 'waba-1',
      components: { components: [{ type: 'BODY', text: 'Hello {{1}}, see you at the clinic.' }] },
      ...over,
    });

    it.each([
      WHATSAPP_TEMPLATE_STATUS.DRAFT,
      WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW,
      WHATSAPP_TEMPLATE_STATUS.REJECTED,
      WHATSAPP_TEMPLATE_STATUS.PAUSED,
      WHATSAPP_TEMPLATE_STATUS.DISABLED,
    ])('refuses a %s template', async (status) => {
      templates.findOne.mockResolvedValueOnce(tpl({ status }));
      await expect(service.getSendableTemplate(TENANT, 'tpl1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('allows an approved template', async () => {
      templates.findOne.mockResolvedValueOnce(tpl());
      await expect(service.getSendableTemplate(TENANT, 'tpl1', 'waba-1')).resolves.toMatchObject({
        id: 'tpl1',
      });
    });

    it('refuses to send through a number on a different WABA', async () => {
      templates.findOne.mockResolvedValueOnce(tpl());
      await expect(service.getSendableTemplate(TENANT, 'tpl1', 'waba-OTHER')).rejects.toMatchObject({
        publicContext: { reason: 'WABA_MISMATCH' },
      });
    });

    it('refuses a template shape this platform cannot fill (header/button parameters)', async () => {
      templates.findOne.mockResolvedValueOnce(
        tpl({
          components: {
            components: [
              { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
              { type: 'BODY', text: 'Body text here for you.' },
            ],
          },
        }),
      );
      await expect(service.getSendableTemplate(TENANT, 'tpl1')).rejects.toMatchObject({
        publicContext: { reason: 'UNSUPPORTED_TEMPLATE_SHAPE' },
      });
    });
  });

  // ─────────────────────── local edits & variable binding ───────────────────

  describe('editing', () => {
    it('refuses to rewrite the components of a template that lives on Meta', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', provider_template_id: 'meta-1' });
      await expect(
        service.update(TENANT, 'tpl1', { components: SIMPLE_BODY } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('still allows re-pointing a Meta template at another account', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', provider_template_id: 'meta-1' });
      templates.save.mockImplementationOnce(async (t: any) => t);
      const res = await service.update(TENANT, 'tpl1', { accountId: 'acc-2' } as any);
      expect(res.whatsapp_account).toEqual({ id: 'acc-2' });
    });
  });

  describe('setVariableMapping', () => {
    const withBody = () => ({
      id: 'tpl1',
      components: { components: [{ type: 'BODY', text: 'Hello {{1}}, on {{2}} at the clinic.' }] },
    });

    it('stores a mapping of declared placeholders to known sources', async () => {
      templates.findOne
        .mockResolvedValueOnce(withBody())
        .mockResolvedValueOnce({ ...withBody(), variable_mapping: { '1': 'patient_name' } });
      templates.save.mockImplementationOnce(async (t: any) => t);

      await service.setVariableMapping(TENANT, 'tpl1', { '1': 'patient_name', '2': 'appointment_date' });
      expect(templates.save.mock.calls[0][0].variable_mapping).toEqual({
        '1': 'patient_name',
        '2': 'appointment_date',
      });
    });

    it('rejects a placeholder the template does not declare', async () => {
      templates.findOne.mockResolvedValueOnce(withBody());
      await expect(
        service.setVariableMapping(TENANT, 'tpl1', { '9': 'patient_name' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(templates.save).not.toHaveBeenCalled();
    });

    it('rejects a source outside the closed vocabulary (no arbitrary field access)', async () => {
      templates.findOne.mockResolvedValueOnce(withBody());
      await expect(
        service.setVariableMapping(TENANT, 'tpl1', { '1': 'customer.national_id' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(templates.save).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────── listing / delete ───────────────────────────

  describe('findAll', () => {
    it('never returns the account’s access-token envelope and flags stale statuses', async () => {
      templates.findAndCount.mockResolvedValueOnce([
        [
          {
            id: 'tpl1',
            name: 'a',
            last_synced_at: new Date('2020-01-01'),
            whatsapp_account: {
              id: 'acc-1',
              display_phone_number: '+966500000000',
              verified_name: 'Clinic',
              access_token: 'enc:v1:SECRET',
              phone_number_id: 'pn',
            },
          },
          { id: 'tpl2', name: 'b', last_synced_at: new Date(), whatsapp_account: null },
          { id: 'tpl3', name: 'c', last_synced_at: null, whatsapp_account: null },
        ],
        3,
      ]);

      const res = await service.findAll(TENANT, { page: 1, limit: 10 } as any);

      expect(JSON.stringify(res)).not.toContain('SECRET');
      expect(res.data[0].whatsapp_account).toEqual({
        id: 'acc-1',
        display_phone_number: '+966500000000',
        verified_name: 'Clinic',
      });
      expect(res.data.map((d) => d.needs_refresh)).toEqual([true, false, true]);
      expect(templates.findAndCount.mock.calls[0][0].where).toMatchObject({ tenant: { id: TENANT } });
    });
  });

  describe('remove', () => {
    const live = () => ({
      id: 'tpl1',
      name: 'x_template',
      provider_template_id: 'meta-1',
      waba_id: 'waba-1',
      whatsapp_account: { id: 'acc-1' },
    });

    it('deletes on Meta first, then soft-removes the mirror', async () => {
      templates.findOne.mockResolvedValueOnce(live());
      await service.remove(TENANT, 'tpl1');
      expect(graph.deleteTemplate).toHaveBeenCalledWith('waba-1', 'tok-1', 'meta-1', 'x_template');
      expect(templates.softRemove).toHaveBeenCalled();
    });

    it('keeps the row when Meta refuses the delete', async () => {
      templates.findOne.mockResolvedValueOnce(live());
      graph.deleteTemplate.mockRejectedValueOnce(metaError({ kind: 'timeout', retriable: true }));
      await expect(service.remove(TENANT, 'tpl1')).rejects.toBeInstanceOf(AppError);
      expect(templates.softRemove).not.toHaveBeenCalled();
    });

    it('treats "already gone on Meta" as success', async () => {
      templates.findOne.mockResolvedValueOnce(live());
      graph.deleteTemplate.mockRejectedValueOnce(
        metaError({ kind: 'rejected', retriable: false, httpStatus: 404, metaCode: 100, metaSubcode: 33 }),
      );
      await service.remove(TENANT, 'tpl1');
      expect(templates.softRemove).toHaveBeenCalled();
    });

    it('refuses while a notification template still uses it', async () => {
      templates.findOne.mockResolvedValueOnce(live());
      const qb = createMockQueryBuilder();
      qb.getCount.mockResolvedValue(2);
      notificationTemplates.createQueryBuilder.mockReturnValue(qb);

      await expect(service.remove(TENANT, 'tpl1')).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(graph.deleteTemplate).not.toHaveBeenCalled();
      expect(templates.softRemove).not.toHaveBeenCalled();
    });

    it('removes a never-submitted local row without calling Meta', async () => {
      templates.findOne.mockResolvedValueOnce({ id: 'tpl1', provider_template_id: null });
      await service.remove(TENANT, 'tpl1');
      expect(graph.deleteTemplate).not.toHaveBeenCalled();
      expect(templates.softRemove).toHaveBeenCalled();
    });
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
