import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  NotificationRuleLibraryService,
  RULE_AUDIT_ACTION,
} from './rule-library.service';
import { RULE_LIBRARY } from './rule-library.catalog';
import { NotificationRule } from '../../../entities/Notifications/NotificationRule';
import { NotificationTemplate } from '../../../entities/Notifications/NotificationTemplate';
import { ScheduledNotification } from '../../../entities/Notifications/ScheduledNotification';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../../entities/SaaS-Core/TenantSetting';
import { Campaign } from '../../../entities/Campaigns/Campaign';
import { ErrorCode } from '../../../common/errors';
import { ActivityAuditService } from '../../activity-log/activity-audit.service';
import { WhatsappTemplateService } from '../../whatsapp/whatsapp-template.service';
import { NotificationTemplateService } from '../notification-template.service';
import {
  createMockQueryBuilder,
  createMockRepository,
  MockRepository,
} from '../../../../test/utils/mock-factories';

const TENANT = 't1';
const OTHER = 't2';
const ACTOR = 'u1';

/** A WhatsApp template view as `WhatsappTemplateService.toView` returns it. */
const view = (over: Record<string, unknown> = {}) => ({
  id: 'wa-1',
  name: 'appointment_reminder_24h',
  language: 'ar',
  status: 'approved',
  category: 'UTILITY',
  provider_template_id: 'meta-1',
  needs_refresh: false,
  readiness: { ready: true, reasons: [] },
  ...over,
});

describe('NotificationRuleLibraryService', () => {
  let service: NotificationRuleLibraryService;
  let rules: MockRepository;
  let notificationTemplates: MockRepository;
  let scheduled: MockRepository;
  let tenants: MockRepository;
  let settings: MockRepository;
  let campaigns: MockRepository;
  let waTemplates: {
    findOne: jest.Mock;
    findOneView: jest.Mock;
    refresh: jest.Mock;
  };
  let templateService: { create: jest.Mock; assertLinkable: jest.Mock };
  let audit: { record: jest.Mock };
  let insertQb: ReturnType<typeof createMockQueryBuilder>;

  const ruleRow = (key: string, over: Record<string, unknown> = {}) => {
    const def = RULE_LIBRARY.find((d) => d.key === key)!;
    return {
      id: `rule-${key}`,
      rule_key: key,
      name: def.name,
      trigger_event: def.trigger,
      anchor: def.anchor,
      delay_minutes: def.defaultDelayMinutes,
      is_active: false,
      conditions: def.defaultConditions,
      template: undefined as unknown,
      last_run_at: null,
      last_error: null,
      ...over,
    };
  };
  const allRows = (over: Record<string, Record<string, unknown>> = {}) =>
    RULE_LIBRARY.map((d) => ruleRow(d.key, over[d.key] ?? {}));

  /** A rule row wired to a WhatsApp template through its notification template. */
  const withTemplate = {
    template: { id: 'nt-1', provider_template_id: 'wa-1' },
  };

  beforeEach(async () => {
    rules = createMockRepository();
    notificationTemplates = createMockRepository();
    scheduled = createMockRepository();
    tenants = createMockRepository();
    settings = createMockRepository();
    campaigns = createMockRepository();
    insertQb = createMockQueryBuilder();
    rules.createQueryBuilder.mockReturnValue(insertQb);
    rules.find.mockResolvedValue(allRows());
    rules.save.mockImplementation((r: unknown) => Promise.resolve(r));
    tenants.findOne.mockResolvedValue({
      id: TENANT,
      default_timezone: 'Asia/Riyadh',
    });
    settings.findOne.mockResolvedValue({
      reminders_enabled: false,
      reminder_lead_minutes: [],
    });
    rules.count.mockResolvedValue(0);
    const statsQb = Object.assign(createMockQueryBuilder(), {
      addGroupBy: jest.fn(function (this: unknown) {
        return this;
      }),
    });
    scheduled.createQueryBuilder.mockReturnValue(statsQb);
    waTemplates = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'wa-1', provider_template_id: 'meta-1' }),
      findOneView: jest.fn().mockResolvedValue(view()),
      refresh: jest.fn().mockResolvedValue(view()),
    };
    templateService = {
      create: jest.fn().mockResolvedValue({ id: 'nt-new' }),
      assertLinkable: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationRuleLibraryService,
        { provide: getRepositoryToken(NotificationRule), useValue: rules },
        {
          provide: getRepositoryToken(NotificationTemplate),
          useValue: notificationTemplates,
        },
        {
          provide: getRepositoryToken(ScheduledNotification),
          useValue: scheduled,
        },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(TenantSetting), useValue: settings },
        { provide: getRepositoryToken(Campaign), useValue: campaigns },
        { provide: WhatsappTemplateService, useValue: waTemplates },
        { provide: NotificationTemplateService, useValue: templateService },
        { provide: ActivityAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(NotificationRuleLibraryService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Seeding ────────────────────────────────────────────────────────────────

  describe('the six default rules', () => {
    it('are created DISABLED, in one idempotent insert that ignores existing rows', async () => {
      await service.list(TENANT);

      expect(insertQb.orIgnore).toHaveBeenCalledTimes(1);
      const values = insertQb.values.mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(values).toHaveLength(6);
      expect(values.map((v) => v.rule_key).sort()).toEqual(
        RULE_LIBRARY.map((d) => d.key).sort(),
      );
      expect(values.every((v) => v.is_active === false)).toBe(true);
      expect(
        values.every((v) => (v.tenant as { id: string }).id === TENANT),
      ).toBe(true);
    });

    it('seeding twice issues the same ignore-on-conflict statement, never an update', async () => {
      await service.list(TENANT);
      await service.list(TENANT);
      expect(insertQb.orIgnore).toHaveBeenCalledTimes(2);
      expect(rules.update).not.toHaveBeenCalled();
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('reads only the caller tenant', async () => {
      await service.list(OTHER);
      expect(rules.find.mock.calls[0][0].where.tenant).toEqual({ id: OTHER });
    });

    it('returns them in catalog order with their defaults', async () => {
      const out = await service.list(TENANT);
      expect(out.map((r) => r.key)).toEqual(RULE_LIBRARY.map((d) => d.key));
      const reminder = out.find((r) => r.key === 'reminder_24h')!;
      expect(reminder).toMatchObject({
        delay_minutes: 1440,
        anchor: 'BEFORE_APPOINTMENT_START',
        is_active: false,
        conditions: { sendWindow: { startHour: 9, endHour: 21 } },
      });
    });
  });

  // ── Enable guard ───────────────────────────────────────────────────────────

  describe('enabling a rule', () => {
    const ready = (key: string, extra: Record<string, unknown> = {}) =>
      rules.findOne.mockResolvedValue(
        ruleRow(key, { ...withTemplate, ...extra }),
      );

    it('refuses a rule with no template and says so', async () => {
      rules.findOne.mockResolvedValue(ruleRow('booking_confirmation'));
      await expect(
        service.enable(TENANT, 'rule-booking_confirmation', ACTOR),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: {
          reason: 'RULE_NOT_READY',
          blockers: [{ code: 'NO_TEMPLATE' }],
        },
      });
      expect(rules.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses a template that is not approved, naming WHY it is not ready', async () => {
      ready('booking_confirmation');
      waTemplates.findOneView.mockResolvedValue(
        view({
          status: 'pending_review',
          readiness: {
            ready: false,
            reasons: [{ code: 'IN_REVIEW', blocking: true }],
          },
        }),
      );
      await expect(service.enable(TENANT, 'r', ACTOR)).rejects.toMatchObject({
        publicContext: {
          blockers: [{ code: 'TEMPLATE_NOT_READY', reasons: ['IN_REVIEW'] }],
        },
      });
    });

    it('refuses a template that is not approved even if readiness says nothing blocking', async () => {
      ready('booking_confirmation');
      waTemplates.findOneView.mockResolvedValue(view({ status: 'rejected' }));
      await expect(service.enable(TENANT, 'r', ACTOR)).rejects.toMatchObject({
        publicContext: {
          blockers: [expect.objectContaining({ code: 'TEMPLATE_NOT_READY' })],
        },
      });
    });

    it('re-reads a STALE status from Meta before relying on it', async () => {
      ready('booking_confirmation');
      waTemplates.findOneView.mockResolvedValue(view({ needs_refresh: true }));
      waTemplates.refresh.mockResolvedValue(view({ needs_refresh: false }));

      await service.enable(TENANT, 'r', ACTOR);

      expect(waTemplates.refresh).toHaveBeenCalledWith(TENANT, 'wa-1');
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: true }),
      );
    });

    it('refuses when the stale status could not be re-confirmed (Meta unreachable)', async () => {
      ready('booking_confirmation');
      waTemplates.findOneView.mockResolvedValue(view({ needs_refresh: true }));
      waTemplates.refresh.mockRejectedValue(new Error('network'));
      await expect(service.enable(TENANT, 'r', ACTOR)).rejects.toMatchObject({
        publicContext: { blockers: [{ code: 'STATUS_UNCONFIRMED' }] },
      });
    });

    it('enables a ready rule and audits who did it', async () => {
      ready('booking_confirmation');
      const out = await service.enable(TENANT, 'r', ACTOR);
      // Readiness needs the connected account, which only the VIEW loads (the raw
      // row made every approved template read as NO_ACCOUNT on a real database).
      expect(waTemplates.findOneView).toHaveBeenCalledWith(TENANT, 'wa-1');
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: true }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          action: RULE_AUDIT_ACTION.ENABLED,
          actorUserId: ACTOR,
          entityType: 'notification_rule',
        }),
      );
      expect(out).toBeDefined();
    });

    it('enabling an already enabled rule changes and audits nothing', async () => {
      ready('booking_confirmation', { is_active: true });
      await service.enable(TENANT, 'r', ACTOR);
      expect(rules.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('enables the follow-up-due rule once its template is ready', async () => {
      ready('followup_due');
      await service.enable(TENANT, 'r', ACTOR);
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: true }),
      );
    });

    it('refuses a rule with a send window when the clinic has no timezone', async () => {
      ready('reminder_24h');
      tenants.findOne.mockResolvedValue({ id: TENANT, default_timezone: '' });
      await expect(service.enable(TENANT, 'r', ACTOR)).rejects.toMatchObject({
        publicContext: {
          blockers: expect.arrayContaining([{ code: 'NO_TIMEZONE' }]),
        },
      });
    });

    it('refuses a timezone that is not a real zone', async () => {
      ready('reminder_24h');
      tenants.findOne.mockResolvedValue({
        id: TENANT,
        default_timezone: 'Mars/Olympus',
      });
      await expect(service.enable(TENANT, 'r', ACTOR)).rejects.toMatchObject({
        publicContext: {
          blockers: expect.arrayContaining([{ code: 'NO_TIMEZONE' }]),
        },
      });
    });

    it('refuses the 24h reminder while Settings → Reminders already sends one', async () => {
      ready('reminder_24h');
      settings.findOne.mockResolvedValue({
        reminders_enabled: true,
        reminder_lead_minutes: [1440],
      });
      rules.count.mockResolvedValue(1); // an active legacy reminder rule with a message
      await expect(service.enable(TENANT, 'r', ACTOR)).rejects.toMatchObject({
        publicContext: {
          blockers: expect.arrayContaining([
            { code: 'REMINDER_SETTINGS_CONFLICT' },
          ]),
        },
      });
    });

    it('allows the 24h reminder when Settings reminders are on but not near 24h', async () => {
      ready('reminder_24h');
      settings.findOne.mockResolvedValue({
        reminders_enabled: true,
        reminder_lead_minutes: [120],
      });
      rules.count.mockResolvedValue(1);
      await expect(service.enable(TENANT, 'r', ACTOR)).resolves.toBeDefined();
    });

    it('allows the 24h reminder when Settings reminders are on but have no message configured', async () => {
      ready('reminder_24h');
      settings.findOne.mockResolvedValue({
        reminders_enabled: true,
        reminder_lead_minutes: [1440],
      });
      rules.count.mockResolvedValue(0);
      await expect(service.enable(TENANT, 'r', ACTOR)).resolves.toBeDefined();
    });

    it('scheduled promotion needs no template (campaigns carry their own)', async () => {
      rules.findOne.mockResolvedValue(ruleRow('scheduled_promotion'));
      await expect(service.enable(TENANT, 'r', ACTOR)).resolves.toBeDefined();
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: true }),
      );
    });

    it("another tenant's rule is a 404, never enabled", async () => {
      rules.findOne.mockResolvedValue(null);
      await expect(
        service.enable(OTHER, 'someone-elses-rule', ACTOR),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(rules.findOne.mock.calls[0][0].where.tenant).toEqual({
        id: OTHER,
      });
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('a hand-made rule (no rule_key) is not a library rule', async () => {
      rules.findOne.mockResolvedValue({ id: 'x', rule_key: null });
      await expect(service.enable(TENANT, 'x', ACTOR)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('assertCanEnable (the guard every enable path shares)', () => {
    it('passes a hand-made rule through untouched', async () => {
      await expect(
        service.assertCanEnable(TENANT, { id: 'x', rule_key: null } as never),
      ).resolves.toBeUndefined();
      expect(waTemplates.findOne).not.toHaveBeenCalled();
    });
  });

  describe('disabling', () => {
    it('turns an active rule off and audits it', async () => {
      rules.findOne.mockResolvedValue(
        ruleRow('booking_confirmation', { is_active: true }),
      );
      await service.disable(TENANT, 'r', ACTOR);
      expect(rules.save).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: false }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: RULE_AUDIT_ACTION.DISABLED,
          actorUserId: ACTOR,
        }),
      );
    });
  });

  // ── Configure ──────────────────────────────────────────────────────────────

  describe('configuring a rule', () => {
    it('validates the delay against the rule’s own range', async () => {
      rules.findOne.mockResolvedValue(ruleRow('reminder_24h'));
      await expect(
        service.configure(TENANT, 'r', { delayMinutes: 5 }, ACTOR),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      await expect(
        service.configure(TENANT, 'r', { delayMinutes: 20_000 }, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('rejects unknown or out-of-range settings instead of dropping them', async () => {
      rules.findOne.mockResolvedValue(ruleRow('patient_reengagement'));
      await expect(
        service.configure(
          TENANT,
          'r',
          { conditions: { inactivityDays: 5 } },
          ACTOR,
        ),
      ).rejects.toMatchObject({
        publicContext: {
          reason: 'INVALID_RULE_CONDITIONS',
          field: 'inactivityDays',
        },
      });
      await expect(
        service.configure(
          TENANT,
          'r',
          { conditions: { script: 'alert(1)' } },
          ACTOR,
        ),
      ).rejects.toMatchObject({ publicContext: { field: 'script' } });
    });

    it('stores valid settings merged over the defaults, and never switches the rule on', async () => {
      rules.findOne.mockResolvedValue(ruleRow('patient_reengagement'));
      await service.configure(
        TENANT,
        'r',
        { conditions: { inactivityDays: 90 } },
        ACTOR,
      );
      const saved = rules.save.mock.calls[0][0];
      expect(saved.conditions).toMatchObject({
        inactivityDays: 90,
        cooldownDays: 90,
        dailyCap: 100,
      });
      expect(saved.is_active).toBe(false);
    });

    it('creates the bridging notification template through the validating service, once', async () => {
      rules.findOne.mockResolvedValue(ruleRow('booking_confirmation'));
      notificationTemplates.findOne.mockResolvedValue(null);

      await service.configure(
        TENANT,
        'r',
        { whatsappTemplateId: 'wa-1' },
        ACTOR,
      );

      expect(templateService.create).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({
          channel: 'WHATSAPP',
          providerTemplateId: 'wa-1',
          type: 'library_rule',
        }),
      );
      expect(rules.save.mock.calls[0][0].template).toEqual({ id: 'nt-new' });
    });

    it('reuses an existing bridge instead of duplicating it', async () => {
      rules.findOne.mockResolvedValue(ruleRow('booking_confirmation'));
      notificationTemplates.findOne.mockResolvedValue({ id: 'nt-existing' });

      await service.configure(
        TENANT,
        'r',
        { whatsappTemplateId: 'wa-1' },
        ACTOR,
      );

      expect(templateService.create).not.toHaveBeenCalled();
      expect(templateService.assertLinkable).toHaveBeenCalled();
      expect(rules.save.mock.calls[0][0].template).toEqual({
        id: 'nt-existing',
      });
    });

    it('will not link a template that cannot be used (the validator refuses)', async () => {
      rules.findOne.mockResolvedValue(ruleRow('booking_confirmation'));
      notificationTemplates.findOne.mockResolvedValue(null);
      templateService.create.mockRejectedValue(new Error('not approved'));
      await expect(
        service.configure(TENANT, 'r', { whatsappTemplateId: 'wa-1' }, ACTOR),
      ).rejects.toThrow('not approved');
      expect(rules.save).not.toHaveBeenCalled();
    });

    it('clearing the template of a RUNNING rule switches it off rather than leave it pointing nowhere', async () => {
      rules.findOne.mockResolvedValue(
        ruleRow('booking_confirmation', { ...withTemplate, is_active: true }),
      );
      await service.configure(TENANT, 'r', { whatsappTemplateId: null }, ACTOR);
      const saved = rules.save.mock.calls[0][0];
      expect(saved.template).toBeUndefined();
      expect(saved.is_active).toBe(false);
    });

    it('refuses a template on the campaign-launching rule', async () => {
      rules.findOne.mockResolvedValue(ruleRow('scheduled_promotion'));
      await expect(
        service.configure(TENANT, 'r', { whatsappTemplateId: 'wa-1' }, ACTOR),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('audits WHICH settings changed, never their values or any message text', async () => {
      rules.findOne.mockResolvedValue(ruleRow('reminder_24h'));
      await service.configure(TENANT, 'r', { delayMinutes: 720 }, ACTOR);
      const entry = audit.record.mock.calls[0][0];
      expect(entry.action).toBe(RULE_AUDIT_ACTION.CONFIGURED);
      expect(entry.after).toEqual({ changed: ['delayMinutes'] });
    });
  });

  // ── Executions ─────────────────────────────────────────────────────────────

  describe('executions', () => {
    it('returns labels only: no recipient, no content', async () => {
      rules.findOne.mockResolvedValue(ruleRow('booking_confirmation'));
      scheduled.find.mockResolvedValue([
        {
          id: 's1',
          status: 'FAILED',
          delivery_status: 'NONE',
          skip_reason: null,
          failure_reason: 'whatsapp failed for +966501234567',
          channel: 'WHATSAPP',
          attempts: 2,
          scheduled_at: new Date(),
          sent_at: null,
          recipient_id: 'cust-1',
          variables: { cancelUrl: 'https://x/SECRET' },
        },
      ]);
      const out = await service.executions(TENANT, 'r', 10);
      expect(Object.keys(out[0]).sort()).toEqual(
        [
          'attempts',
          'channel',
          'delivery_status',
          'failure_reason',
          'id',
          'scheduled_at',
          'sent_at',
          'skip_reason',
          'status',
        ].sort(),
      );
      expect(JSON.stringify(out)).not.toContain('SECRET');
      expect(JSON.stringify(out)).not.toContain('cust-1');
      expect(JSON.stringify(out)).not.toContain('+966501234567'); // scrubbed
    });

    it('is scoped to the tenant and bounded', async () => {
      rules.findOne.mockResolvedValue(ruleRow('booking_confirmation'));
      await service.executions(TENANT, 'r', 9999);
      const q = scheduled.find.mock.calls[0][0];
      expect(q.where.tenant).toEqual({ id: TENANT });
      expect(q.take).toBe(50);
    });

    it("404s for another tenant's rule", async () => {
      rules.findOne.mockResolvedValue(null);
      await expect(service.executions(OTHER, 'r')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(scheduled.find).not.toHaveBeenCalled();
    });
  });

  describe('recordRun', () => {
    it('stores a scrubbed, bounded error and never throws', async () => {
      await service.recordRun(
        'rule-1',
        `failed for +966501234567 ${'x'.repeat(500)}`,
      );
      const patch = rules.update.mock.calls[0][1];
      expect(patch.last_error.length).toBeLessThanOrEqual(200);
      expect(patch.last_error).not.toContain('+966501234567');

      rules.update.mockRejectedValueOnce(new Error('db'));
      await expect(service.recordRun('rule-1')).resolves.toBeUndefined();
    });

    it('clears the error on a clean run', async () => {
      await service.recordRun('rule-1');
      expect(rules.update.mock.calls[0][1]).toMatchObject({ last_error: null });
    });
  });

  describe('timezoneOf', () => {
    it('falls back to UTC when unset or invalid', async () => {
      tenants.findOne.mockResolvedValueOnce({
        id: TENANT,
        default_timezone: '',
      });
      expect(await service.timezoneOf(TENANT)).toBe('UTC');
      tenants.findOne.mockResolvedValueOnce({
        id: TENANT,
        default_timezone: 'Nope/Nope',
      });
      expect(await service.timezoneOf(TENANT)).toBe('UTC');
      tenants.findOne.mockResolvedValueOnce({
        id: TENANT,
        default_timezone: 'Asia/Riyadh',
      });
      expect(await service.timezoneOf(TENANT)).toBe('Asia/Riyadh');
    });
  });
});
