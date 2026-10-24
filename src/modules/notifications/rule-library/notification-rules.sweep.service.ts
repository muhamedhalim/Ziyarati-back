import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AccessControlService } from '../../subscription-billing/access-control.service';
import { FeatureKey } from '../../subscription-billing/feature-registry';
import { NotificationSchedulerService } from '../notification-scheduler.service';
import { RECIPIENT_TYPE } from '../notification.constants';
import { NotificationRuleLibraryService } from './rule-library.service';
import { normalizeConditions } from './rule-conditions';
import { RULE_KEY, findRuleDef } from './rule-library.catalog';
import { buildRuleSourceRef } from './rule-source-ref';
import {
  dateOnlyEpoch,
  localDateIn,
} from '../../appointment/follow-up-date.util';

/** Clinic-local hour a daily sweep rule acts at, kept inside the rule's send window. */
export const REENGAGEMENT_LOCAL_HOUR = 10;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const PAGE = 200;
const DAY_MS = 86_400_000;

export interface RulesSweepOptions {
  /** Renews the sweep's lock; `false` means it was lost and the run must stop. */
  keepAlive?: () => Promise<boolean>;
}

export interface RulesSweepResult {
  tenants: number;
  processed: number;
  scheduled: number;
}

/** A follow-up due this many days ago or fewer is still sent (covers a missed run); older ones lapse. */
export const FOLLOWUP_CATCH_UP_DAYS = 7;

interface DueRule {
  id: string;
  tenantId: string;
  rule_key?: string;
  templateId: string | null;
  conditions: Record<string, unknown> | null;
  tz: string | null;
}

/**
 * Time-driven ready-made rules: they depend on the calendar, not on an event.
 * Today that is patient re-engagement; the follow-up-due rule joins it in its own
 * phase.
 *
 * The same shape as the birthday sweep: hourly tick, each clinic acts at its OWN
 * local hour, only clinics that have the rule ENABLED are visited, one clinic's
 * failure never stops the rest, and a renewed lock stops a run that lost it.
 *
 * What it will and will not do for re-engagement:
 *  - only active patients with a phone who agreed to marketing and have not opted
 *    out (the send seam checks consent again — this just avoids useless rows);
 *  - only patients whose LAST completed visit is older than `inactivityDays`, with
 *    NO upcoming appointment;
 *  - never the same patient twice within `cooldownDays` (a row from this rule in
 *    that period, in any state, counts), and at most `dailyCap` per clinic per day;
 *  - every row has a deterministic `source_ref`, so a re-run the same hour cannot
 *    duplicate anything.
 */
@Injectable()
export class NotificationRulesSweepService {
  private readonly logger = new Logger(NotificationRulesSweepService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly scheduler: NotificationSchedulerService,
    private readonly library: NotificationRuleLibraryService,
    @Optional() private readonly access?: AccessControlService,
  ) {}

  async sweep(
    now: Date = new Date(),
    opts: RulesSweepOptions = {},
  ): Promise<RulesSweepResult> {
    const due: DueRule[] = await this.dataSource.query(
      `SELECT r.id, r."tenantId", r.rule_key, r.conditions, nt.id AS "templateId", t.default_timezone AS tz
         FROM notification_rules r
         JOIN tenants t ON t.id = r."tenantId"
         LEFT JOIN notification_templates nt ON nt.id = r."templateId"
        WHERE r.rule_key = ANY($1::text[]) AND r.is_active = true
          AND t.is_active = true AND t.deleted_at IS NULL`,
      [[RULE_KEY.PATIENT_REENGAGEMENT, RULE_KEY.FOLLOWUP_DUE]],
    );

    const result: RulesSweepResult = {
      tenants: due.length,
      processed: 0,
      scheduled: 0,
    };
    for (const rule of due) {
      if (opts.keepAlive && !(await opts.keepAlive())) {
        this.logger.warn('rules sweep lost its lock — aborting this run');
        break;
      }
      try {
        if (!rule.templateId) continue;
        const followUp = rule.rule_key === RULE_KEY.FOLLOWUP_DUE;
        const def = findRuleDef(
          followUp ? RULE_KEY.FOLLOWUP_DUE : RULE_KEY.PATIENT_REENGAGEMENT,
        )!;
        const cond = normalizeConditions(def, rule.conditions);
        const tz = await this.library.timezoneOf(rule.tenantId);
        const window = cond.sendWindow!;
        const hour = Math.min(
          Math.max(REENGAGEMENT_LOCAL_HOUR, window.startHour),
          window.endHour - 1,
        );
        if (localHour(now, tz) !== hour) continue;
        if (!(await this.entitled(rule.tenantId))) continue;

        result.processed += 1;
        result.scheduled += followUp
          ? await this.followUpDue(rule, tz, now)
          : await this.reengage(rule, cond, now);
      } catch (err) {
        // One clinic's failure must not stop the others.
        const message = (err as Error)?.message ?? 'sweep failed';
        this.logger.error(
          `rules sweep (${rule.rule_key ?? 'reengagement'}) failed for tenant ${rule.tenantId}: ${message}`,
        );
        await this.library.recordRun(rule.id, message);
      }
    }
    return result;
  }

  private async entitled(tenantId: string): Promise<boolean> {
    if (!this.access) return true;
    const decision = await this.access.resolve(
      tenantId,
      FeatureKey.NOTIFICATIONS,
    );
    return (
      decision.allowed ||
      !this.access.shouldBlock(decision, {
        surface: 'worker',
        detail: 'notifications.rulesSweep',
      })
    );
  }

  /**
   * Medical follow-up when due. The DATE is a clinician's decision
   * (`appointments.follow_up_due_on`); this only notices it has arrived.
   *
   * A patient is invited when ALL hold: the appointment is still COMPLETED, its
   * date is today (clinic-local) or up to {@link FOLLOWUP_CATCH_UP_DAYS} days ago,
   * the patient is active, reachable, consenting and not opted out, has no upcoming
   * appointment, and has not already had a later completed visit (they came back).
   * `source_ref` pins one message to (rule, appointment, date): a re-run, or a
   * second sweep the same day, cannot send it twice, and moving the date makes a
   * new, separate message.
   */
  private async followUpDue(
    rule: DueRule,
    timeZone: string,
    now: Date,
  ): Promise<number> {
    const today = localDateIn(now, timeZone);
    let scheduled = 0;
    let after = NIL_UUID;
    for (;;) {
      const rows: Array<{ id: string; customerId: string; due: string }> =
        await this.dataSource.query(
          `SELECT a.id, a."customerId", a.follow_up_due_on::text AS due
             FROM appointments a
             JOIN customers c ON c.id = a."customerId" AND c."tenantId" = a."tenantId"
            WHERE a."tenantId" = $1 AND a.deleted_at IS NULL
              AND a.status = 'COMPLETED'
              AND a.follow_up_due_on IS NOT NULL
              AND a.follow_up_due_on <= $2::date
              AND a.follow_up_due_on > $2::date - $3::int
              AND c.deleted_at IS NULL AND c.is_active = true
              AND c.opted_out_at IS NULL AND c.marketing_opt_in = true
              AND COALESCE(BTRIM(c.phone), '') <> ''
              AND NOT EXISTS (
                SELECT 1 FROM appointments b
                 WHERE b."customerId" = a."customerId" AND b."tenantId" = $1 AND b.deleted_at IS NULL
                   AND b.id <> a.id
                   AND ((b.status IN ('CONFIRMED','PENDING_PAYMENT','IN_PROGRESS') AND b.start_at > now())
                     OR (b.status = 'COMPLETED' AND b.start_at > a.start_at)))
              AND NOT EXISTS (
                SELECT 1 FROM scheduled_notifications n
                 WHERE n."tenantId" = $1 AND n.notification_rule_id = $4 AND n."appointmentId" = a.id
                   AND n.source_ref = 'rule:' || $4::text || ':followup:' || a.id::text || ':'
                       || (extract(epoch FROM a.follow_up_due_on::timestamp)::bigint * 1000)::text)
              AND a.id > $5
            ORDER BY a.id
            LIMIT ${PAGE}`,
          [rule.tenantId, today, FOLLOWUP_CATCH_UP_DAYS, rule.id, after],
        );
      if (rows.length === 0) break;

      for (const row of rows) {
        after = row.id;
        const row0 = await this.scheduler.schedule(
          rule.tenantId,
          {
            templateId: rule.templateId as string,
            recipientType: RECIPIENT_TYPE.CUSTOMER,
            recipientId: row.customerId,
            appointmentId: row.id,
            scheduledAt: now.toISOString(),
          },
          // rule:{ruleId}:followup:{appointmentId}:{dueDate as UTC epoch ms}
          buildRuleSourceRef({
            ruleId: rule.id,
            kind: 'followup',
            appointmentId: row.id,
            startEpoch: dateOnlyEpoch(row.due),
          }),
          undefined,
          rule.id,
        );
        if (row0) scheduled += 1;
      }
      if (rows.length < PAGE) break;
    }
    if (scheduled > 0) await this.library.recordRun(rule.id);
    return scheduled;
  }

  private async reengage(
    rule: DueRule,
    cond: ReturnType<typeof normalizeConditions>,
    now: Date,
  ): Promise<number> {
    const inactivityDays = cond.inactivityDays as number;
    const cooldownDays = cond.cooldownDays as number;
    const dailyCap = cond.dailyCap as number;

    // How many this rule already scheduled today — the cap is per DAY, not per run.
    const [{ n }] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM scheduled_notifications
        WHERE "tenantId" = $1 AND notification_rule_id = $2 AND created_at >= date_trunc('day', now())`,
      [rule.tenantId, rule.id],
    );
    let remaining = dailyCap - Number(n);
    if (remaining <= 0) return 0;

    // One bucket per cooldown period: the same patient in the same period → same key.
    const period = Math.floor(now.getTime() / (cooldownDays * DAY_MS));

    let scheduled = 0;
    let after = NIL_UUID;
    while (remaining > 0) {
      const limit = Math.min(PAGE, remaining);
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `SELECT c.id
           FROM customers c
          WHERE c."tenantId" = $1
            AND c.deleted_at IS NULL AND c.is_active = true
            AND c.opted_out_at IS NULL AND c.marketing_opt_in = true
            AND COALESCE(BTRIM(c.phone), '') <> ''
            AND EXISTS (
              SELECT 1 FROM appointments a
               WHERE a."customerId" = c.id AND a."tenantId" = $1
                 AND a.status = 'COMPLETED' AND a.deleted_at IS NULL)
            AND NOT EXISTS (
              SELECT 1 FROM appointments a
               WHERE a."customerId" = c.id AND a."tenantId" = $1 AND a.deleted_at IS NULL
                 AND (
                   (a.status = 'COMPLETED' AND a.start_at > now() - ($2::int * interval '1 day'))
                   OR (a.status IN ('CONFIRMED','PENDING_PAYMENT','IN_PROGRESS') AND a.start_at > now())
                 ))
            AND NOT EXISTS (
              SELECT 1 FROM scheduled_notifications n
               WHERE n."tenantId" = $1 AND n.notification_rule_id = $3 AND n.recipient_id = c.id
                 AND n.created_at > now() - ($4::int * interval '1 day'))
            AND c.id > $5
          ORDER BY c.id
          LIMIT $6`,
        [rule.tenantId, inactivityDays, rule.id, cooldownDays, after, limit],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        after = row.id;
        const row0 = await this.scheduler.schedule(
          rule.tenantId,
          {
            templateId: rule.templateId as string,
            recipientType: RECIPIENT_TYPE.CUSTOMER,
            recipientId: row.id,
            scheduledAt: now.toISOString(),
          },
          // rule:{ruleId}:reengage:{customerId}:{period} — parsed by the same helper.
          `rule:${rule.id}:reengage:${row.id}:${period}`,
          undefined,
          rule.id,
        );
        if (row0) {
          scheduled += 1;
          remaining -= 1;
        }
        if (remaining <= 0) break;
      }
      if (rows.length < limit) break;
    }
    if (scheduled > 0) await this.library.recordRun(rule.id);
    return scheduled;
  }
}

/** The clinic-local hour (0–23) at `now`; an unknown zone falls back to UTC. */
function localHour(now: Date, timeZone: string): number {
  const options = { hour: 'numeric', hourCycle: 'h23' } as const;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone,
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: 'UTC',
    }).formatToParts(now);
  }
  return Number(parts.find((p) => p.type === 'hour')?.value);
}
