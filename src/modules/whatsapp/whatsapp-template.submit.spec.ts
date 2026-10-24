import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { MetaGraphClient } from './meta/meta-graph.client';
import { WhatsappAccountResolver } from './routing/whatsapp-account.resolver';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';
import {
  buildLibraryComponents,
  TEMPLATE_LIBRARY,
} from './template-library/template-library.catalog';
import {
  WHATSAPP_TEMPLATE_AUDIT_ACTION,
  WHATSAPP_TEMPLATE_STATUS,
} from './whatsapp.constants';

const TENANT = 't1';
const FULL = {
  appUrl: 'https://app.test',
  clinicPhone: '+966501234567',
  offerUrl: 'https://c.test/o',
};

const def = (key: string) => TEMPLATE_LIBRARY.find((d) => d.key === key)!;

/** A library draft row exactly as `adopt` stores it. */
const draft = (
  key = 'appointment_reminder_24h',
  over: Record<string, unknown> = {},
) => {
  const d = def(key);
  return {
    id: 'tpl-1',
    name: d.name,
    language: d.language,
    category: d.proposedCategory,
    status: WHATSAPP_TEMPLATE_STATUS.DRAFT,
    library_key: d.key,
    library_version: d.version,
    components: {
      components: buildLibraryComponents(d, FULL),
      parameter_format: 'POSITIONAL',
    },
    variable_mapping: { ...d.defaultMapping },
    provider_template_id: null,
    waba_id: null,
    whatsapp_account: { id: 'acc-1' },
    ...over,
  } as any;
};

function metaError(meta: Record<string, unknown>) {
  return new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
    message: 'Meta rejected the request',
    publicContext: { meta },
    internalContext: { metaCode: meta.metaCode, metaSubcode: meta.metaSubcode },
  });
}

describe('WhatsappTemplateService — drafts, submit, resubmit, mapping rules', () => {
  let service: WhatsappTemplateService;
  let templates: MockRepository;
  let graph: Record<string, jest.Mock>;
  let resolver: { byId: jest.Mock; forTenant: jest.Mock };
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    templates = createMockRepository();
    templates.save.mockImplementation(async (t: any) => t);
    graph = {
      createTemplate: jest.fn().mockResolvedValue({
        id: 'meta-1',
        status: 'PENDING',
        category: 'UTILITY',
      }),
      editTemplate: jest.fn().mockResolvedValue(undefined),
      getTemplate: jest.fn(),
      findTemplatesByName: jest.fn().mockResolvedValue([]),
      deleteTemplate: jest.fn(),
    };
    resolver = {
      byId: jest.fn().mockResolvedValue({
        id: 'acc-1',
        wabaId: 'waba-1',
        accessToken: 'tok',
      }),
      forTenant: jest.fn().mockResolvedValue({
        id: 'acc-1',
        wabaId: 'waba-1',
        accessToken: 'tok',
      }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappTemplateService,
        { provide: getRepositoryToken(WhatsappTemplate), useValue: templates },
        {
          provide: getRepositoryToken(WhatsappAccount),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(NotificationTemplate),
          useValue: createMockRepository(),
        },
        { provide: MetaGraphClient, useValue: graph },
        { provide: WhatsappAccountResolver, useValue: resolver },
        { provide: ActivityAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(WhatsappTemplateService);
  });

  /** findOne is used by submit/resubmit for the row, then findOneView re-reads it. */
  const rowIs = (row: any) => templates.findOne.mockResolvedValue(row);

  describe('submit', () => {
    it('sends a validated draft to Meta, then mirrors Meta’s id, status and category — never approved', async () => {
      const row = draft();
      rowIs(row);

      const view = await service.submit(TENANT, 'tpl-1', 'user-1');

      expect(graph.createTemplate).toHaveBeenCalledTimes(1);
      const [waba, token, payload] = graph.createTemplate.mock.calls[0];
      expect([waba, token]).toEqual(['waba-1', 'tok']);
      expect(payload).toMatchObject({
        name: 'appointment_reminder_24h',
        language: 'ar',
        category: 'UTILITY',
      });
      expect(
        payload.components.find((c: any) => c.type === 'BODY').example
          .body_text[0],
      ).toHaveLength(4);

      expect(row).toMatchObject({
        provider_template_id: 'meta-1',
        waba_id: 'waba-1',
        status: WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW,
      });
      expect(view.status).not.toBe(WHATSAPP_TEMPLATE_STATUS.APPROVED);
      expect(view.readiness.ready).toBe(false);
    });

    it('records Meta’s category when it differs from the proposal (Meta decides)', async () => {
      graph.createTemplate.mockResolvedValue({
        id: 'meta-1',
        status: 'PENDING',
        category: 'MARKETING',
      });
      const row = draft();
      rowIs(row);
      await service.submit(TENANT, 'tpl-1');
      expect(row.category).toBe('MARKETING');
    });

    it('is audited with ids and statuses only — no text, no phone number', async () => {
      rowIs(draft());
      await service.submit(TENANT, 'tpl-1', 'user-1');
      expect(audit.record).toHaveBeenCalledTimes(1);
      const entry = audit.record.mock.calls[0][0];
      expect(entry).toMatchObject({
        tenantId: TENANT,
        action: WHATSAPP_TEMPLATE_AUDIT_ACTION.SUBMITTED,
        actorUserId: 'user-1',
        entityId: 'tpl-1',
      });
      expect(JSON.stringify(entry)).not.toMatch(/966501234567|مرحباً/);
    });

    it('collapses a double click onto ONE Meta call', async () => {
      rowIs(draft());
      let release!: () => void;
      graph.createTemplate.mockImplementation(
        () =>
          new Promise(
            (res) =>
              (release = () =>
                res({ id: 'meta-1', status: 'PENDING', category: 'UTILITY' })),
          ),
      );

      const a = service.submit(TENANT, 'tpl-1');
      const b = service.submit(TENANT, 'tpl-1');
      await new Promise((r) => setImmediate(r));
      release();
      await Promise.all([a, b]);

      expect(graph.createTemplate).toHaveBeenCalledTimes(1);
    });

    it('refuses a template that is not a draft — 409, Meta untouched', async () => {
      rowIs(
        draft('appointment_reminder_24h', {
          status: 'pending_review',
          provider_template_id: 'meta-9',
        }),
      );
      await expect(service.submit(TENANT, 'tpl-1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('does not call Meta for a draft that still has a blank install-time value (no phone)', async () => {
      const d = def('appointment_reminder_24h');
      rowIs(
        draft('appointment_reminder_24h', {
          components: {
            components: buildLibraryComponents(d, {
              appUrl: 'https://app.test',
            }),
          },
        }),
      );
      await expect(service.submit(TENANT, 'tpl-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
        publicContext: {
          validation: {
            issues: expect.arrayContaining([
              expect.objectContaining({ code: 'BUTTON_PHONE_REQUIRED' }),
            ]),
          },
        },
      });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('does not call Meta when the account has no WABA or token', async () => {
      resolver.byId.mockResolvedValue({ id: 'acc-1' });
      rowIs(draft());
      await expect(service.submit(TENANT, 'tpl-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(graph.createTemplate).not.toHaveBeenCalled();
    });

    it('surfaces Meta’s own words when it refuses, and leaves the draft a draft', async () => {
      graph.createTemplate.mockRejectedValue(
        metaError({
          kind: 'rejected',
          metaCode: 100,
          httpStatus: 400,
          metaDetail: 'bad',
        }),
      );
      const row = draft();
      rowIs(row);
      await expect(service.submit(TENANT, 'tpl-1')).rejects.toMatchObject({
        publicContext: { meta: { metaCode: 100 } },
      });
      expect(row.status).toBe(WHATSAPP_TEMPLATE_STATUS.DRAFT);
      expect(row.provider_template_id).toBeNull();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('after a timeout, adopts the template Meta DID create instead of reporting failure', async () => {
      graph.createTemplate.mockRejectedValue(metaError({ kind: 'timeout' }));
      graph.findTemplatesByName.mockResolvedValue([
        {
          id: 'meta-77',
          name: 'appointment_reminder_24h',
          language: 'ar',
          status: 'PENDING',
          category: 'UTILITY',
        },
      ]);
      const row = draft();
      rowIs(row);
      await service.submit(TENANT, 'tpl-1');
      expect(row.provider_template_id).toBe('meta-77');
      expect(row.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });

    it('after a timeout where Meta has no such template, says the outcome is unknown and changes nothing', async () => {
      graph.createTemplate.mockRejectedValue(metaError({ kind: 'timeout' }));
      const row = draft();
      rowIs(row);
      await expect(service.submit(TENANT, 'tpl-1')).rejects.toMatchObject({
        publicContext: { meta: { outcomeUnknown: true } },
      });
      expect(row.status).toBe(WHATSAPP_TEMPLATE_STATUS.DRAFT);
    });

    it('queries by tenant — a draft of another clinic is 404', async () => {
      templates.findOne.mockResolvedValue(null);
      await expect(service.submit(TENANT, 'foreign')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(templates.findOne.mock.calls[0][0].where).toMatchObject({
        id: 'foreign',
        tenant: { id: TENANT },
      });
    });
  });

  describe('resubmit', () => {
    const corrected = () => def('appointment_reminder_24h');
    const dto = () =>
      ({
        components: buildLibraryComponents(corrected(), FULL).map((c) =>
          c.type === 'BODY'
            ? { type: 'BODY', text: c.text, example: c.example!.body_text![0] }
            : {
                type: 'BUTTONS',
                buttons: c.buttons!.map((b) => ({
                  type: b.type,
                  text: b.text,
                  phoneNumber: b.phone_number,
                })),
              },
        ),
      }) as any;

    const rejected = (over: Record<string, unknown> = {}) =>
      draft('appointment_reminder_24h', {
        status: WHATSAPP_TEMPLATE_STATUS.REJECTED,
        provider_template_id: 'meta-1',
        waba_id: 'waba-1',
        rejected_reason: 'INVALID_FORMAT',
        ...over,
      });

    it('edits a REJECTED template in place on Meta and returns it to review', async () => {
      const row = rejected();
      rowIs(row);
      graph.getTemplate.mockResolvedValue(null); // read-back unavailable → stays pending_review

      await service
        .resubmit(TENANT, 'tpl-1', dto(), 'user-1')
        .catch(() => undefined);

      expect(graph.editTemplate).toHaveBeenCalledTimes(1);
      const [metaId, token, payload] = graph.editTemplate.mock.calls[0];
      expect([metaId, token]).toEqual(['meta-1', 'tok']);
      expect(payload.components.some((c: any) => c.type === 'BODY')).toBe(true);
      expect(row.rejected_reason).toBeNull();
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: WHATSAPP_TEMPLATE_AUDIT_ACTION.RESUBMITTED,
      });
    });

    it('takes Meta’s real status from the read-back rather than assuming one', async () => {
      const row = rejected();
      rowIs(row);
      graph.getTemplate.mockResolvedValue({
        id: 'meta-1',
        name: row.name,
        language: 'ar',
        status: 'PENDING',
        category: 'UTILITY',
        components: [],
      });
      const view = await service.resubmit(TENANT, 'tpl-1', dto());
      expect(graph.getTemplate).toHaveBeenCalledWith('meta-1', 'tok');
      expect(view.status).toBe(WHATSAPP_TEMPLATE_STATUS.PENDING_REVIEW);
    });

    it('also allows a PAUSED template', async () => {
      rowIs(rejected({ status: WHATSAPP_TEMPLATE_STATUS.PAUSED }));
      graph.getTemplate.mockResolvedValue(null);
      await service.resubmit(TENANT, 'tpl-1', dto()).catch(() => undefined);
      expect(graph.editTemplate).toHaveBeenCalled();
    });

    it.each(['approved', 'pending_review', 'draft', 'disabled'])(
      'refuses to edit a %s template — Meta untouched',
      async (status) => {
        rowIs(
          rejected({
            status,
            provider_template_id: status === 'draft' ? null : 'meta-1',
          }),
        );
        await expect(
          service.resubmit(TENANT, 'tpl-1', dto()),
        ).rejects.toMatchObject({
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          publicContext: { reason: 'NOT_RESUBMITTABLE' },
        });
        expect(graph.editTemplate).not.toHaveBeenCalled();
      },
    );

    it('re-validates: a corrected template that is still invalid never reaches Meta', async () => {
      rowIs(rejected());
      const bad = {
        components: [{ type: 'BODY', text: '{{1}} مرحباً', example: ['x'] }],
      } as any;
      await expect(
        service.resubmit(TENANT, 'tpl-1', bad),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(graph.editTemplate).not.toHaveBeenCalled();
    });

    it('leaves the stored verdict alone when Meta refuses the edit', async () => {
      const row = rejected();
      rowIs(row);
      graph.editTemplate.mockRejectedValue(
        metaError({ kind: 'rejected', metaCode: 100 }),
      );
      await expect(
        service.resubmit(TENANT, 'tpl-1', dto()),
      ).rejects.toBeDefined();
      expect(row.status).toBe(WHATSAPP_TEMPLATE_STATUS.REJECTED);
      expect(row.rejected_reason).toBe('INVALID_FORMAT');
    });

    it('after a timeout, tells the user to refresh and does not claim success', async () => {
      const row = rejected();
      rowIs(row);
      graph.editTemplate.mockRejectedValue(metaError({ kind: 'timeout' }));
      await expect(
        service.resubmit(TENANT, 'tpl-1', dto()),
      ).rejects.toMatchObject({
        publicContext: { meta: { outcomeUnknown: true } },
      });
      expect(row.status).toBe(WHATSAPP_TEMPLATE_STATUS.REJECTED);
    });
  });

  describe('variable mapping rules', () => {
    const confirmation = () => draft('appointment_confirmation');

    it('accepts the secure link only on its link button, and typed text only on a body placeholder', async () => {
      rowIs(confirmation());
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', {
          '1': 'patient_first_name',
          '3': 'fixed:الكشف الأول',
          button_0: 'reschedule_token',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses to print the reschedule token as message text', async () => {
      rowIs(confirmation());
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', {
          '1': 'reschedule_token',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('refuses to put a patient’s name (or anything else) into a link', async () => {
      rowIs(confirmation());
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', {
          button_0: 'patient_name',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', { button_0: 'fixed:abc' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it.each([
      ['blank', 'fixed:   '],
      ['multi-line', 'fixed:a\nb'],
      ['braces', 'fixed:{{1}}'],
      ['too long', `fixed:${'x'.repeat(101)}`],
      ['a national id', 'fixed:1234567890'],
      ['clinical wording', 'fixed:diagnosis results'],
    ])('rejects typed text that is %s', async (_label, value) => {
      rowIs(confirmation());
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', { '3': value }),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('rejects a placeholder the template does not declare and an unknown source', async () => {
      rowIs(confirmation());
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', { '9': 'patient_name' }),
      ).rejects.toBeDefined();
      await expect(
        service.setVariableMapping(TENANT, 'tpl-1', { '1': 'diagnosis' }),
      ).rejects.toBeDefined();
    });

    it('audits placeholder names only — never the typed text', async () => {
      rowIs(confirmation());
      await service.setVariableMapping(
        TENANT,
        'tpl-1',
        { '3': 'fixed:الكشف الأول' },
        'user-1',
      );
      const entry = audit.record.mock.calls[0][0];
      expect(entry.after).toEqual({ placeholders: ['3'] });
      expect(JSON.stringify(entry)).not.toContain('الكشف');
    });
  });

  describe('readiness on the view', () => {
    it('is not ready while a draft, and says why', () => {
      const view = service.toView({
        ...draft(),
        whatsapp_account: {
          id: 'acc-1',
          connection_status: 'CONNECTED',
          is_active: true,
        },
      } as any);
      expect(view.readiness.ready).toBe(false);
      expect(view.readiness.reasons.map((r) => r.code)).toContain(
        'NOT_SUBMITTED',
      );
    });

    it('is ready only when approved, connected, bound and the WABA matches', () => {
      const ready = service.toView({
        ...draft('appointment_reminder_24h', {
          status: 'approved',
          provider_template_id: 'm',
          waba_id: 'waba-1',
          last_synced_at: new Date(),
        }),
        whatsapp_account: {
          id: 'acc-1',
          waba_id: 'waba-1',
          connection_status: 'CONNECTED',
          is_active: true,
        },
      } as any);
      expect(ready.readiness).toEqual({ ready: true, reasons: [] });

      const mismatch = service.toView({
        ...draft('appointment_reminder_24h', {
          status: 'approved',
          provider_template_id: 'm',
          waba_id: 'waba-1',
          last_synced_at: new Date(),
        }),
        whatsapp_account: {
          id: 'acc-1',
          waba_id: 'waba-OTHER',
          connection_status: 'CONNECTED',
          is_active: true,
        },
      } as any);
      expect(mismatch.readiness.ready).toBe(false);
      expect(mismatch.readiness.reasons.map((r) => r.code)).toContain(
        'WABA_MISMATCH',
      );
    });
  });
});
