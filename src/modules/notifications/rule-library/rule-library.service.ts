import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { NotificationRule } from '../../../entities/Notifications/NotificationRule';
import { NotificationTemplate } from '../../../entities/Notifications/NotificationTemplate';
import { ScheduledNotification } from '../../../entities/Notifications/ScheduledNotification';
import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../../entities/SaaS-Core/TenantSetting';
import { Campaign } from '../../../entities/Campaigns/Campaign';
import { AppError, ErrorCode } from '../../../common/errors';
import { scrubFailureReason } from '../../../common/utils/log-scrubber.util';
import { ActivityAuditService } from '../../activity-log/activity-audit.service';
import { WhatsappTemplateService } from '../../whatsapp/whatsapp-template.service';
import { NotificationTemplateService } from '../notification-template.service';
import { NOTIFICATION_STATUS } from '../notification.constants';
import { REMINDER_TRIGGER_EVENT } from '../reminder-scheduler.service';
import { assertDelay, normalizeConditions } from './rule-conditions';
import {
  findRuleDef,
  RULE_LIBRARY,
  RuleLibraryDef,
} from './rule-library.catalog';
import { ConfigureLibraryRuleDto } from './configure-library-rule.dto';

/** One thing standing between a rule and being switched on. */
export interface EnableBlocker {
  code:
    | 'NOT_AVAILABLE'
    | 'NO_TEMPLATE'
    | 'TEMPLATE_NOT_READY'
    | 'STATUS_UNCONFIRMED'
    | 'NO_TIMEZONE'
    | 'REMINDER_SETTINGS_CONFLICT';
  /** Readiness reason codes for `TEMPLATE_NOT_READY` (the template's own explanation). */
  reasons?: string[];
}

export interface RuleStats {
  scheduled: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

export const RULE_AUDIT_ACTION = {
  ENABLED: 'notification.rule.enabled',
  DISABLED: 'notification.rule.disabled',
  CONFIGURED: 'notification.rule.configured',
} as const;

const STATS_DAYS = 30;
/** A reminder lead time within this many minutes of 24h counts as "the 24h reminder". */
const REMINDER_24H_TOLERANCE_MIN = 60;

/**
 * The ready-made automation rules, on top of the existing rules engine.
 *
 *  - `list` makes sure the clinic has its six rules (all DISABLED — nothing sends
 *    until the owner chooses a template and switches one on) and returns each with
 *    its template, last run, 30-day counts and what still blocks enabling it.
 *  - Enabling is guarded HERE, on the server: the UI explains the blockers, it
 *    does not decide. The same guard runs for the generic enable endpoint.
 *  - Every query is scoped by the tenant from the request context.
 */
@Injectable()
export class NotificationRuleLibraryService {
  private readonly logger = new Logger(NotificationRuleLibraryService.name);

  constructor(
    @InjectRepository(NotificationRule)
    private readonly rules: Repository<NotificationRule>,
    @InjectRepository(NotificationTemplate)
    private readonly notificationTemplates: Repository<NotificationTemplate>,
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
    @InjectRepository(TenantSetting)
    private readonly settings: Repository<TenantSetting>,
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    private readonly whatsappTemplates: WhatsappTemplateService,
    private readonly templateService: NotificationTemplateService,
    private readonly audit: ActivityAuditService,
  ) {}

  // ─────────────────────────────── Read ─────────────────────────────── //

  async list(tenantId: string) {
    await this.ensureSeeded(tenantId);
    const rows = await this.libraryRows(tenantId);
    const stats = await this.statsByRule(
      tenantId,
      rows.map((r) => r.id),
    );

    return Promise.all(
      rows.map(async (rule) => {
        const def = findRuleDef(rule.rule_key) as RuleLibraryDef;
        const template = await this.templateView(tenantId, rule);
        return {
          id: rule.id,
          key: def.key,
          name: rule.name ?? def.name,
          trigger_event: rule.trigger_event,
          anchor: rule.anchor,
          delay_minutes: rule.delay_minutes,
          delay_range: def.delayRange,
          is_active: rule.is_active,
          available: def.available,
          uses_template: def.usesTemplate,
          marketing: def.marketing || template?.category === 'MARKETING',
          recommended_template_key: def.templateLibraryKey ?? null,
          conditions: rule.conditions ?? def.defaultConditions,
          condition_keys: def.conditions,
          template,
          last_run_at: rule.last_run_at ?? null,
          last_error: rule.last_error ?? null,
          stats: stats.get(rule.id) ?? emptyStats(),
          stats_days: STATS_DAYS,
          blockers: await this.blockers(tenantId, rule, def, template, false),
          upcoming_campaigns:
            def.key === 'scheduled_promotion'
              ? await this.upcomingCampaigns(tenantId)
              : undefined,
        };
      }),
    );
  }

  /** The last rows this rule produced: status and reason labels only — no content, no recipient. */
  async executions(tenantId: string, ruleId: string, limit = 20) {
    await this.requireLibraryRule(tenantId, ruleId);
    const rows = await this.scheduled.find({
      where: { tenant: { id: tenantId }, notification_rule: { id: ruleId } },
      order: { created_at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      delivery_status: r.delivery_status,
      skip_reason: r.skip_reason ?? null,
      failure_reason: r.failure_reason
        ? scrubFailureReason(r.failure_reason)
        : null,
      channel: r.channel ?? null,
      attempts: r.attempts,
      scheduled_at: r.scheduled_at,
      sent_at: r.sent_at ?? null,
    }));
  }

  // ───────────────────────────── Mutations ───────────────────────────── //

  /** Choose the WhatsApp template, delay and settings of a library rule. Never enables it. */
  async configure(
    tenantId: string,
    ruleId: string,
    dto: ConfigureLibraryRuleDto,
    actorUserId?: string,
  ) {
    const rule = await this.requireLibraryRule(tenantId, ruleId);
    const def = findRuleDef(rule.rule_key) as RuleLibraryDef;

    if (dto.delayMinutes !== undefined) {
      assertDelay(def, dto.delayMinutes);
      rule.delay_minutes = dto.delayMinutes;
    }
    if (dto.conditions !== undefined) {
      rule.conditions = { ...normalizeConditions(def, dto.conditions) };
    }
    if (dto.whatsappTemplateId !== undefined) {
      if (!def.usesTemplate) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'This rule launches campaigns, which carry their own template.',
        });
      }
      rule.template = dto.whatsappTemplateId
        ? ({
            id: await this.bridgeTemplate(
              tenantId,
              def,
              dto.whatsappTemplateId,
            ),
          } as NotificationTemplate)
        : undefined;
      // Changing the template of a RUNNING rule must not leave it pointing at nothing.
      if (!dto.whatsappTemplateId && rule.is_active) rule.is_active = false;
    }
    await this.rules.save(rule);

    await this.audit.record({
      tenantId,
      action: RULE_AUDIT_ACTION.CONFIGURED,
      entityType: 'notification_rule',
      entityId: rule.id,
      entityLabel: def.key,
      actorUserId,
      // Which settings changed — values are numbers and ids, never message text.
      after: {
        changed: Object.keys(dto).filter(
          (k) => (dto as Record<string, unknown>)[k] !== undefined,
        ),
      },
    });
    return this.viewOf(tenantId, rule.id);
  }

  async enable(tenantId: string, ruleId: string, actorUserId?: string) {
    const rule = await this.requireLibraryRule(tenantId, ruleId);
    await this.assertCanEnable(tenantId, rule);
    if (!rule.is_active) {
      rule.is_active = true;
      await this.rules.save(rule);
      await this.auditToggle(
        tenantId,
        rule,
        RULE_AUDIT_ACTION.ENABLED,
        actorUserId,
      );
    }
    return this.viewOf(tenantId, rule.id);
  }

  async disable(tenantId: string, ruleId: string, actorUserId?: string) {
    const rule = await this.requireLibraryRule(tenantId, ruleId);
    if (rule.is_active) {
      rule.is_active = false;
      await this.rules.save(rule);
      await this.auditToggle(
        tenantId,
        rule,
        RULE_AUDIT_ACTION.DISABLED,
        actorUserId,
      );
    }
    return this.viewOf(tenantId, rule.id);
  }

  /**
   * The guard every path that switches a library rule on goes through. A hand-made
   * rule (no `rule_key`) is not judged here — its behaviour is unchanged.
   */
  async assertCanEnable(
    tenantId: string,
    rule: NotificationRule,
  ): Promise<void> {
    const def = findRuleDef(rule.rule_key);
    if (!def) return;
    const template = await this.templateView(tenantId, rule, {
      refreshIfStale: true,
    });
    const blockers = await this.blockers(tenantId, rule, def, template, true);
    if (blockers.length > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This rule cannot be switched on yet.',
        publicContext: { reason: 'RULE_NOT_READY', blockers },
      });
    }
  }

  /** The clinic's IANA timezone, or UTC when none is set / it is not a real zone. */
  async timezoneOf(tenantId: string): Promise<string> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: { id: true, default_timezone: true },
    });
    const tz = tenant?.default_timezone?.trim();
    if (!tz) return 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      return 'UTC';
    }
  }

  /** Record that a rule scheduled something (or failed to). Never throws. */
  async recordRun(ruleId: string, error?: string): Promise<void> {
    try {
      await this.rules.update(
        { id: ruleId },
        {
          last_run_at: new Date(),
          last_error: error ? scrubFailureReason(error).slice(0, 200) : null,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not record run of rule ${ruleId}: ${(err as Error)?.message}`,
      );
    }
  }

  // ───────────────────────────── Internals ───────────────────────────── //

  /** `INSERT … ON CONFLICT DO NOTHING`: idempotent under a double call or two instances. */
  async ensureSeeded(tenantId: string): Promise<void> {
    await this.rules
      .createQueryBuilder()
      .insert()
      .into(NotificationRule)
      .values(
        RULE_LIBRARY.map((def) => ({
          tenant: { id: tenantId } as Tenant,
          rule_key: def.key,
          name: def.name,
          trigger_event: def.trigger,
          anchor: def.anchor,
          delay_minutes: def.defaultDelayMinutes,
          // Off until the owner has chosen a template and switched it on.
          is_active: false,
          conditions: def.defaultConditions as never,
        })),
      )
      .orIgnore()
      .execute();
  }

  private libraryRows(tenantId: string): Promise<NotificationRule[]> {
    return this.rules
      .find({
        where: {
          tenant: { id: tenantId },
          rule_key: In(RULE_LIBRARY.map((d) => d.key)),
        },
        relations: { template: true },
      })
      .then((rows) =>
        rows.sort(
          (a, b) =>
            RULE_LIBRARY.findIndex((d) => d.key === a.rule_key) -
            RULE_LIBRARY.findIndex((d) => d.key === b.rule_key),
        ),
      );
  }

  private async requireLibraryRule(
    tenantId: string,
    ruleId: string,
  ): Promise<NotificationRule> {
    const rule = await this.rules.findOne({
      where: { id: ruleId, tenant: { id: tenantId } },
      relations: { template: true },
    });
    if (!rule || !findRuleDef(rule.rule_key)) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Rule not found' });
    }
    return rule;
  }

  private async viewOf(tenantId: string, ruleId: string) {
    const all = await this.list(tenantId);
    return all.find((r) => r.id === ruleId);
  }

  private async auditToggle(
    tenantId: string,
    rule: NotificationRule,
    action: string,
    actorUserId?: string,
  ) {
    await this.audit.record({
      tenantId,
      action,
      entityType: 'notification_rule',
      entityId: rule.id,
      entityLabel: rule.rule_key ?? undefined,
      actorUserId,
    });
  }

  /** The rule's WhatsApp template as the UI needs it, with the server's readiness verdict. */
  private async templateView(
    tenantId: string,
    rule: NotificationRule,
    opts: { refreshIfStale?: boolean } = {},
  ) {
    const waId = rule.template?.provider_template_id;
    if (!waId) return null;
    try {
      // The VIEW, not the raw row: readiness needs the connected account, which
      // only `findOneView` loads. Without it every template reads as NO_ACCOUNT.
      let view = await this.whatsappTemplates.findOneView(tenantId, waId);
      if (
        opts.refreshIfStale &&
        view.needs_refresh &&
        view.provider_template_id
      ) {
        try {
          // Re-read the real verdict from Meta; `refresh` returns the new view.
          view = await this.whatsappTemplates.refresh(tenantId, waId);
        } catch {
          // Could not reach Meta: the status stays unconfirmed (reported as a blocker).
        }
      }
      return {
        notification_template_id: rule.template?.id ?? null,
        whatsapp_template_id: view.id,
        name: view.name,
        language: view.language,
        status: view.status,
        category: view.category ?? null,
        readiness: view.readiness,
        needs_refresh: view.needs_refresh,
      };
    } catch {
      return null;
    }
  }

  private async blockers(
    tenantId: string,
    rule: NotificationRule,
    def: RuleLibraryDef,
    template: Awaited<
      ReturnType<NotificationRuleLibraryService['templateView']>
    >,
    strict: boolean,
  ): Promise<EnableBlocker[]> {
    const out: EnableBlocker[] = [];
    if (!def.available) out.push({ code: 'NOT_AVAILABLE' });

    if (def.usesTemplate) {
      if (!template) {
        out.push({ code: 'NO_TEMPLATE' });
      } else {
        const hard = template.readiness.reasons
          .filter((r) => r.blocking && r.code !== 'STATUS_STALE')
          .map((r) => r.code);
        if (hard.length > 0 || template.status !== 'approved') {
          out.push({ code: 'TEMPLATE_NOT_READY', reasons: hard });
        } else if (strict && template.needs_refresh) {
          // A stale status was not re-confirmed with Meta just now: do not rely on it.
          out.push({ code: 'STATUS_UNCONFIRMED' });
        }
      }
    }

    if (
      def.conditions.includes('sendWindow') &&
      !(await this.hasTimezone(tenantId))
    ) {
      out.push({ code: 'NO_TIMEZONE' });
    }
    if (
      def.key === 'reminder_24h' &&
      (await this.hasSettingsReminderConflict(tenantId))
    ) {
      out.push({ code: 'REMINDER_SETTINGS_CONFLICT' });
    }
    void rule;
    return out;
  }

  private async hasTimezone(tenantId: string): Promise<boolean> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: { id: true, default_timezone: true },
    });
    const tz = tenant?.default_timezone?.trim();
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Settings → Reminders already sends a ~24h reminder when it is on and has a
   * message configured. Enabling this rule as well would send every patient two.
   */
  private async hasSettingsReminderConflict(
    tenantId: string,
  ): Promise<boolean> {
    const settings = await this.settings.findOne({
      where: { tenant: { id: tenantId } },
    });
    if (!settings?.reminders_enabled) return false;
    const near24h = (settings.reminder_lead_minutes ?? []).some(
      (m) => Math.abs(m - 1440) <= REMINDER_24H_TOLERANCE_MIN,
    );
    if (!near24h) return false;
    const legacy = await this.rules.count({
      where: {
        tenant: { id: tenantId },
        trigger_event: REMINDER_TRIGGER_EVENT,
        is_active: true,
      },
    });
    return legacy > 0;
  }

  /** The notification template that points a rule at a WhatsApp template (reused, never duplicated). */
  private async bridgeTemplate(
    tenantId: string,
    def: RuleLibraryDef,
    whatsappTemplateId: string,
  ): Promise<string> {
    const existing = await this.notificationTemplates.findOne({
      where: {
        tenant: { id: tenantId },
        provider_template_id: whatsappTemplateId,
        channel: 'WHATSAPP',
        type: 'library_rule',
      },
    });
    // `create` re-validates the WhatsApp template (tenant, approved, shape, bound).
    const wa = await this.whatsappTemplates.findOne(
      tenantId,
      whatsappTemplateId,
    );
    if (existing) {
      this.templateService.assertLinkable(wa);
      return existing.id;
    }
    const created = await this.templateService.create(tenantId, {
      name: `${def.name} — ${wa.name}`.slice(0, 100),
      type: 'library_rule',
      channel: 'WHATSAPP',
      providerTemplateId: whatsappTemplateId,
      isActive: true,
    });
    return created.id;
  }

  private async upcomingCampaigns(tenantId: string) {
    const rows = await this.campaigns.find({
      where: { tenant: { id: tenantId }, lifecycle: 'SCHEDULED' as never },
      order: { scheduled_at: 'ASC' },
      take: 10,
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      scheduled_at: c.scheduled_at ?? null,
    }));
  }

  private async statsByRule(
    tenantId: string,
    ruleIds: string[],
  ): Promise<Map<string, RuleStats>> {
    const out = new Map<string, RuleStats>();
    if (ruleIds.length === 0) return out;
    const rows: Array<{
      rule: string;
      status: string;
      skip: string | null;
      n: string;
    }> = await this.scheduled
      .createQueryBuilder('n')
      .select('n.notification_rule_id', 'rule')
      .addSelect('n.status', 'status')
      .addSelect('n.skip_reason', 'skip')
      .addSelect('COUNT(*)', 'n')
      .where('n."tenantId" = :tenantId', { tenantId })
      .andWhere('n.notification_rule_id IN (:...ruleIds)', { ruleIds })
      .andWhere(`n.created_at >= now() - (:days || ' days')::interval`, {
        days: String(STATS_DAYS),
      })
      .groupBy('n.notification_rule_id')
      .addGroupBy('n.status')
      .addGroupBy('n.skip_reason')
      .getRawMany();

    for (const r of rows) {
      const s = out.get(r.rule) ?? emptyStats();
      const n = Number(r.n);
      s.scheduled += n;
      if (
        r.status === NOTIFICATION_STATUS.SENT ||
        r.status === NOTIFICATION_STATUS.DELIVERED
      )
        s.sent += n;
      else if (r.status === NOTIFICATION_STATUS.CANCELLED) s.skipped += n;
      else if (
        r.status === NOTIFICATION_STATUS.FAILED ||
        r.status === NOTIFICATION_STATUS.SEND_UNCERTAIN
      ) {
        // A refusal for consent / no reachable recipient is a skip by design, not a fault.
        if (r.skip) s.skipped += n;
        else s.failed += n;
      } else s.pending += n;
      out.set(r.rule, s);
    }
    return out;
  }
}

function emptyStats(): RuleStats {
  return { scheduled: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
}
