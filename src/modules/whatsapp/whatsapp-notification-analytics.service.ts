import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NOTIFICATION_STATUS } from '../notifications/notification.constants';
import {
  AnalyticsRange,
  buildAlerts,
  buildFailureReasons,
  compareCount,
  compareRate,
  computeRates,
  DELIVERY_CONFIRMATION_GRACE_MS,
  resolveWindows,
  safeTimeZone,
  toCounts,
} from './whatsapp-notification-analytics.calc';

/** Templates listed in the breakdown; one extra is fetched to know it was cut. */
const TEMPLATE_LIMIT = 10;

// Status vocabulary, as SQL fragments. `SENT` plus the legacy `DELIVERED`
// status both mean "the provider accepted it".
const SENT = `n.status IN ('${NOTIFICATION_STATUS.SENT}','${NOTIFICATION_STATUS.DELIVERED}')`;
// Delivery receipts only exist for messages WhatsApp actually carried, so every
// delivery/read ratio is restricted to these rows (an email fallback has none).
const WA_SENT = `${SENT} AND n.channel = 'WHATSAPP'`;
const PENDING = `n.status IN ('${NOTIFICATION_STATUS.PENDING}','${NOTIFICATION_STATUS.SCHEDULED}','${NOTIFICATION_STATUS.PROCESSING}')`;

/** The aggregate columns shared by the period query and the template query. */
const COUNT_COLUMNS = (matureParam: string) => `
  COUNT(*)::int                                                              AS "total",
  COUNT(*) FILTER (WHERE ${PENDING})::int                                    AS "pending",
  COUNT(*) FILTER (WHERE n.status = '${NOTIFICATION_STATUS.CANCELLED}')::int AS "cancelled",
  COUNT(*) FILTER (WHERE ${SENT})::int                                       AS "sent",
  COUNT(*) FILTER (WHERE n.status = '${NOTIFICATION_STATUS.FAILED}')::int    AS "failed",
  COUNT(*) FILTER (WHERE n.status = '${NOTIFICATION_STATUS.SEND_UNCERTAIN}')::int AS "uncertain",
  COUNT(*) FILTER (WHERE ${WA_SENT})::int                                    AS "whatsappSent",
  COUNT(*) FILTER (WHERE ${SENT} AND n.channel = 'EMAIL')::int               AS "emailFallback",
  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.delivery_status IN ('DELIVERED','READ'))::int AS "delivered",
  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.delivery_status = 'READ')::int     AS "read",
  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.delivery_status = 'FAILED')::int   AS "carrierFailed",
  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.delivery_status IN ('NONE','ACCEPTED'))::int AS "awaitingConfirmation",
  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.sent_at < ${matureParam})::int     AS "matureWhatsappSent",
  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.sent_at < ${matureParam}
                     AND n.delivery_status IN ('NONE','ACCEPTED'))::int      AS "matureUnconfirmed"`;

export interface TemplateBreakdownRow {
  templateId: string;
  name: string;
  total: number;
  sent: number;
  failed: number;
  whatsappSent: number;
  delivered: number;
  read: number;
  deliveryRate: number | null;
}

/**
 * Delivery analytics for the clinic's AUTOMATIC WhatsApp notifications
 * (rule/reminder sends tracked on `scheduled_notifications`).
 *
 * WHY THIS TABLE AND NOT `notification_logs`. Meta's delivered/read callbacks
 * are applied to `scheduled_notifications.delivery_status` (see
 * `NotificationDeliveryService`) — `notification_logs.status` only ever holds
 * the send outcome, so a delivery/read rate computed there is structurally 0.
 * `notification_logs` is also one row per ATTEMPT (a transient failure that is
 * retried writes a FAILED row and later a SENT row), which would overstate
 * failures and double-count the dispatcher's own SENT log.
 *
 * TENANT ISOLATION. Every query is bound to `n."tenantId" = $1` taken from the
 * authenticated tenant context — never from the request.
 *
 * COST. Each request is four reads, each bounded by tenant AND a time range of
 * at most 2 × 90 days, with conditional aggregation instead of one query per
 * metric. No per-row work in the application, no N+1.
 */
@Injectable()
export class WhatsappNotificationAnalyticsService {
  constructor(
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
  ) {}

  async summary(
    tenantId: string,
    range: AnalyticsRange,
    tenantTimeZone?: string | null,
    now: Date = new Date(),
  ) {
    const tz = safeTimeZone(tenantTimeZone);
    const { current, previous } = resolveWindows(range, now);
    const matureCutoff = new Date(
      now.getTime() - DELIVERY_CONFIRMATION_GRACE_MS,
    );

    const base = `
      FROM scheduled_notifications n
      INNER JOIN notification_templates t ON t.id = n."templateId"
      WHERE n."tenantId" = $1
        AND t.channel = 'WHATSAPP'`;

    const [periodRows, trendRows, templateRows, failureRows] =
      await Promise.all([
        this.scheduled.query(
          `SELECT CASE WHEN n.scheduled_at >= $3 THEN 'current' ELSE 'previous' END AS "period",
                ${COUNT_COLUMNS('$5::timestamptz')}
         ${base}
           AND n.scheduled_at >= $2 AND n.scheduled_at < $4
         GROUP BY 1`,
          [tenantId, previous.from, current.from, current.to, matureCutoff],
        ) as Promise<Array<Record<string, unknown>>>,

        // One row per local calendar day of the current period, zero-filled so
        // the chart has no silent gaps.
        this.scheduled.query(
          `WITH days AS (
           SELECT generate_series(
                    ($2::timestamptz AT TIME ZONE $4)::date,
                    (($3::timestamptz - interval '1 microsecond') AT TIME ZONE $4)::date,
                    interval '1 day')::date AS day
         ),
         agg AS (
           SELECT (n.scheduled_at AT TIME ZONE $4)::date AS day,
                  COUNT(*)::int AS "total",
                  COUNT(*) FILTER (WHERE ${SENT})::int AS "sent",
                  COUNT(*) FILTER (WHERE n.status = '${NOTIFICATION_STATUS.FAILED}')::int AS "failed",
                  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.delivery_status IN ('DELIVERED','READ'))::int AS "delivered",
                  COUNT(*) FILTER (WHERE ${WA_SENT} AND n.delivery_status = 'READ')::int AS "read"
           ${base}
             AND n.scheduled_at >= $2 AND n.scheduled_at < $3
           GROUP BY 1
         )
         SELECT to_char(d.day, 'YYYY-MM-DD') AS "date",
                COALESCE(a."total", 0) AS "total",
                COALESCE(a."sent", 0) AS "sent",
                COALESCE(a."failed", 0) AS "failed",
                COALESCE(a."delivered", 0) AS "delivered",
                COALESCE(a."read", 0) AS "read"
         FROM days d LEFT JOIN agg a ON a.day = d.day
         ORDER BY d.day`,
          [tenantId, current.from, current.to, tz],
        ) as Promise<Array<Record<string, unknown>>>,

        this.scheduled.query(
          `SELECT t.id AS "templateId", t.name AS "name",
                ${COUNT_COLUMNS('$4::timestamptz')}
         ${base}
           AND n.scheduled_at >= $2 AND n.scheduled_at < $3
         GROUP BY t.id, t.name
         ORDER BY COUNT(*) DESC, t.name ASC
         LIMIT ${TEMPLATE_LIMIT + 1}`,
          [tenantId, current.from, current.to, matureCutoff],
        ) as Promise<Array<Record<string, unknown>>>,

        // Bounded category, never the raw failure text (see FAILURE_REASON_CODES).
        this.scheduled.query(
          `SELECT code AS "code", COUNT(*)::int AS "count" FROM (
           SELECT CASE
                    WHEN n.status = '${NOTIFICATION_STATUS.SEND_UNCERTAIN}' THEN 'SEND_UNCERTAIN'
                    WHEN n.skip_reason IS NOT NULL THEN n.skip_reason
                    WHEN n.failure_reason = 'duplicate-send-prevented' THEN 'DUPLICATE_PREVENTED'
                    WHEN n.failure_reason LIKE 'Template variable(s) could not be resolved%' THEN 'TEMPLATE_VARIABLES'
                    WHEN n.channel IS NOT NULL THEN 'PROVIDER_ERROR'
                    ELSE 'OTHER'
                  END AS code
           ${base}
             AND n.scheduled_at >= $2 AND n.scheduled_at < $3
             AND n.status IN ('${NOTIFICATION_STATUS.FAILED}','${NOTIFICATION_STATUS.SEND_UNCERTAIN}')
         ) x
         GROUP BY code`,
          [tenantId, current.from, current.to],
        ) as Promise<Array<Record<string, unknown>>>,
      ]);

    const byPeriod = new Map(periodRows.map((r) => [String(r.period), r]));
    const currentCounts = toCounts(byPeriod.get('current'));
    const previousCounts = toCounts(byPeriod.get('previous'));
    const cur = computeRates(currentCounts);
    const prev = computeRates(previousCounts);
    const failureReasons = buildFailureReasons(
      failureRows.map((r) => ({ code: r.code, count: r.count })),
    );

    const templates: TemplateBreakdownRow[] = templateRows
      .slice(0, TEMPLATE_LIMIT)
      .map((r) => {
        const c = toCounts(r);
        return {
          templateId: String(r.templateId),
          name: String(r.name ?? ''),
          total: c.total,
          sent: c.sent,
          failed: c.failed,
          whatsappSent: c.whatsappSent,
          delivered: c.delivered,
          read: c.read,
          deliveryRate: computeRates(c).rates.deliveryRate,
        };
      });

    return {
      range,
      timezone: tz,
      generatedAt: now.toISOString(),
      current: {
        from: current.from.toISOString(),
        to: current.to.toISOString(),
        counts: currentCounts,
        ...cur,
      },
      previous: {
        from: previous.from.toISOString(),
        to: previous.to.toISOString(),
        counts: previousCounts,
        ...prev,
      },
      /** False when the previous window holds no notifications at all. */
      hasBaseline: previousCounts.total > 0,
      comparison: {
        total: compareCount(currentCounts.total, previousCounts.total),
        sent: compareCount(currentCounts.sent, previousCounts.sent),
        failed: compareCount(currentCounts.failed, previousCounts.failed),
        successRate: compareRate(cur.rates.successRate, prev.rates.successRate),
        deliveryRate: compareRate(
          cur.rates.deliveryRate,
          prev.rates.deliveryRate,
        ),
        readRate: compareRate(cur.rates.readRate, prev.rates.readRate),
      },
      trend: trendRows.map((r) => {
        const c = toCounts(r);
        return {
          date: String(r.date),
          total: c.total,
          sent: c.sent,
          failed: c.failed,
          delivered: c.delivered,
          read: c.read,
        };
      }),
      byTemplate: templates,
      byTemplateTruncated: templateRows.length > TEMPLATE_LIMIT,
      failureReasons,
      alerts: buildAlerts(currentCounts, failureReasons),
    };
  }
}
