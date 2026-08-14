import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { TenantApprovalStatus } from '../../entities/enums';
import { round2 } from '../payments/payments.constants';
import { MonitoringService } from '../platform-monitoring/monitoring.service';
import { SupportTicketService } from '../support-tickets/support-ticket.service';
import { PlatformUsageService } from '../platform-usage/platform-usage.service';
import {
  DASHBOARD_SUBSCRIPTION_STATE,
  EXPIRING_SOON_DAYS,
  LATEST_SUBSCRIPTION_LATERAL,
  OPEN_UPGRADE_STATUSES,
  TOKEN_EXPIRING_SOON_DAYS,
  effectiveStatusSql,
} from './dashboard.constants';

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const DAY_MS = 86_400_000;

/** Hard ceiling on the feed. Beyond this the operator needs a queue, not a list. */
const MAX_ALERTS = 50;
/** Per-source ceiling, so one noisy category cannot crowd out every other. */
const PER_SOURCE_LIMIT = 10;

export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Every alert the Control Center can raise.
 *
 * These are CODES, not sentences. The backend never composes user-facing prose:
 * `MonitoringService.alerts()` and `PlatformUsageService.alerts()` both return
 * English strings (`"Database is unreachable"`, `"Subscription expired"`), and
 * reusing those verbatim would ship untranslated text to an Arabic operator. A
 * code plus `params` lets the client translate and interpolate, which is the
 * only way this feed can be bilingual.
 */
export const ALERT_CODE = {
  TENANT_PENDING_APPROVAL: 'TENANT_PENDING_APPROVAL',
  VERIFICATION_PENDING: 'VERIFICATION_PENDING',
  SUBSCRIPTION_EXPIRING: 'SUBSCRIPTION_EXPIRING',
  TRIAL_EXPIRING: 'TRIAL_EXPIRING',
  SUBSCRIPTION_PAST_DUE: 'SUBSCRIPTION_PAST_DUE',
  SUBSCRIPTION_GRACE_EXPIRED: 'SUBSCRIPTION_GRACE_EXPIRED',
  NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INTEGRATION_TOKEN_EXPIRED: 'INTEGRATION_TOKEN_EXPIRED',
  INTEGRATION_TOKEN_EXPIRING: 'INTEGRATION_TOKEN_EXPIRING',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  QUOTA_THRESHOLD: 'QUOTA_THRESHOLD',
  TICKET_URGENT: 'TICKET_URGENT',
  JOBS_FAILED: 'JOBS_FAILED',
  WORKER_STALE: 'WORKER_STALE',
  DB_DOWN: 'DB_DOWN',
  REDIS_DOWN: 'REDIS_DOWN',
  WEBHOOK_FAILURES: 'WEBHOOK_FAILURES',
  UPGRADE_REQUEST_PENDING: 'UPGRADE_REQUEST_PENDING',
} as const;

export type AlertCode = (typeof ALERT_CODE)[keyof typeof ALERT_CODE];

export interface DashboardAlert {
  code: AlertCode;
  severity: AlertSeverity;
  /** Values for client-side interpolation. Never a rendered sentence. */
  params: Record<string, string | number>;
  /** The clinic this concerns, when it concerns one. Name + id only. */
  entity?: { type: 'tenant'; id: string; label: string };
  occurredAt?: string;
  /** Where the operator acts on it. */
  cta: { route: string; query?: Record<string, string> };
}

export interface DashboardAlertsResponse {
  alerts: DashboardAlert[];
  totalBySeverity: Record<AlertSeverity, number>;
  truncated: boolean;
  degradedSources: string[];
  collectedAt: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * The unified "needs attention" feed.
 *
 * This is what turns the dashboard from a report into a console: a metric tells
 * an operator a number, an alert tells them what to do about it. Every entry
 * therefore carries a CTA into the page where the action happens.
 *
 * Cost discipline throughout: each contributing source is a single bounded
 * query, they run under `Promise.allSettled` so one failure degrades one
 * category rather than the page, and the response is capped. A landing page
 * that is slow or blank during an incident is worse than no landing page.
 */
@Injectable()
export class DashboardAlertsService {
  private readonly logger = new Logger(DashboardAlertsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly monitoring: MonitoringService,
    private readonly tickets: SupportTicketService,
    private readonly usage: PlatformUsageService,
  ) {}

  async alerts(): Promise<DashboardAlertsResponse> {
    const now = new Date();
    const grace = this.config.get<number>('SUBSCRIPTION_GRACE_DAYS', 14);
    const degradedSources: string[] = [];

    const sources: { name: string; run: () => Promise<DashboardAlert[]> }[] = [
      { name: 'tenants', run: () => this.tenantAlerts() },
      { name: 'subscriptions', run: () => this.subscriptionAlerts(grace, now) },
      { name: 'payments', run: () => this.paymentAlerts(now) },
      { name: 'integrations', run: () => this.integrationAlerts(now) },
      { name: 'quotas', run: () => this.quotaAlerts() },
      { name: 'tickets', run: () => this.ticketAlerts() },
      { name: 'infrastructure', run: () => this.infrastructureAlerts(now) },
      { name: 'upgrades', run: () => this.upgradeAlerts() },
    ];

    const settled = await Promise.allSettled(sources.map((s) => s.run()));
    const all: DashboardAlert[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        all.push(...r.value);
      } else {
        // Named, not silent. An operator seeing "some checks unavailable" can
        // judge the feed's completeness; an operator seeing a short list cannot.
        this.logger.warn(
          `Alert source "${sources[i].name}" failed: ${(r.reason as Error)?.message}`,
        );
        degradedSources.push(sources[i].name);
      }
    });

    const totalBySeverity: Record<AlertSeverity, number> = {
      critical: 0,
      warning: 0,
      info: 0,
    };
    for (const a of all) totalBySeverity[a.severity]++;

    all.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''),
    );

    return {
      alerts: all.slice(0, MAX_ALERTS),
      totalBySeverity,
      truncated: all.length > MAX_ALERTS,
      degradedSources,
      collectedAt: now.toISOString(),
    };
  }

  // ─────────────────────────────── Sources ──────────────────────────────── //

  /** Clinics waiting on a human decision. Grouped — the queue page lists them. */
  private async tenantAlerts(): Promise<DashboardAlert[]> {
    const [row] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM tenants
           WHERE deleted_at IS NULL AND approval_status = '${TenantApprovalStatus.PENDING_APPROVAL}')::int AS pending_approval,
         (SELECT COUNT(DISTINCT "tenantId") FROM tenant_verification_documents
           WHERE status = 'PENDING' AND deleted_at IS NULL)::int AS pending_docs`,
    );
    const out: DashboardAlert[] = [];
    if (n(row?.pending_approval) > 0) {
      out.push({
        code: ALERT_CODE.TENANT_PENDING_APPROVAL,
        severity: 'warning',
        params: { count: n(row.pending_approval) },
        cta: {
          route: '/platform/tenants',
          query: { status: TenantApprovalStatus.PENDING_APPROVAL },
        },
      });
    }
    if (n(row?.pending_docs) > 0) {
      out.push({
        code: ALERT_CODE.VERIFICATION_PENDING,
        severity: 'warning',
        params: { count: n(row.pending_docs) },
        cta: {
          route: '/platform/tenants',
          query: { status: TenantApprovalStatus.PENDING_VERIFICATION },
        },
      });
    }
    return out;
  }

  /**
   * Subscription lifecycle attention, using the CANONICAL effective status.
   *
   * Grouped counts rather than one row per clinic: an operator with 40 expiring
   * subscriptions needs one line and a filtered list, not 40 lines.
   */
  private async subscriptionAlerts(
    grace: number,
    now: Date,
  ): Promise<DashboardAlert[]> {
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY_MS);
    const [row] = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.ACTIVE}' AND ends_at > $2 AND ends_at <= $3)::int AS expiring_active,
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.TRIAL}'  AND ends_at > $2 AND ends_at <= $3)::int AS expiring_trial,
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.PAST_DUE}')::int      AS past_due,
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.GRACE_EXPIRED}')::int AS grace_expired,
         COUNT(*) FILTER (WHERE state = '${DASHBOARD_SUBSCRIPTION_STATE.NONE}' AND approved)::int AS no_subscription
       FROM (
         SELECT (${effectiveStatusSql('sub', '$1')}) AS state, sub.ends_at,
                (t.approval_status = '${TenantApprovalStatus.APPROVED}') AS approved
           FROM tenants t
           ${LATEST_SUBSCRIPTION_LATERAL}
          WHERE t.deleted_at IS NULL
       ) s`,
      [grace, now, soon],
    );

    const out: DashboardAlert[] = [];
    const push = (
      code: AlertCode,
      severity: AlertSeverity,
      count: number,
      query: Record<string, string>,
      extra: Record<string, string | number> = {},
    ) => {
      if (count > 0) {
        out.push({
          code,
          severity,
          params: { count, ...extra },
          cta: { route: '/platform/usage', query },
        });
      }
    };

    push(ALERT_CODE.SUBSCRIPTION_GRACE_EXPIRED, 'critical', n(row?.grace_expired), {
      status: 'EXPIRED',
    });
    push(ALERT_CODE.SUBSCRIPTION_PAST_DUE, 'warning', n(row?.past_due), {
      status: 'PAST_DUE',
    });
    push(
      ALERT_CODE.SUBSCRIPTION_EXPIRING,
      'warning',
      n(row?.expiring_active),
      { status: 'ACTIVE' },
      { days: EXPIRING_SOON_DAYS },
    );
    push(
      ALERT_CODE.TRIAL_EXPIRING,
      'warning',
      n(row?.expiring_trial),
      { status: 'TRIAL' },
      { days: EXPIRING_SOON_DAYS },
    );
    push(ALERT_CODE.NO_SUBSCRIPTION, 'info', n(row?.no_subscription), {
      status: 'NONE',
    });
    return out;
  }

  /** Failed payments in the last 24h — the window an operator can still act in. */
  private async paymentAlerts(now: Date): Promise<DashboardAlert[]> {
    const since = new Date(now.getTime() - DAY_MS);
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS failed, COALESCE(SUM(amount),0) AS amount
         FROM payments WHERE status = 'FAILED' AND created_at >= $1`,
      [since],
    );
    if (n(row?.failed) === 0) return [];
    return [
      {
        code: ALERT_CODE.PAYMENT_FAILED,
        severity: 'warning',
        params: { count: n(row.failed), amount: round2(n(row.amount)), hours: 24 },
        cta: { route: '/platform/finance/transactions', query: { status: 'FAILED' } },
      },
    ];
  }

  /**
   * Broken and soon-to-break WhatsApp connections.
   *
   * Per-clinic, because the action is per-clinic: a revoked token is fixed by
   * that clinic reconnecting, so the operator needs to know WHICH one. Returns
   * `connection_status` and a name — never the token, never `waba_id` or
   * `phone_number_id`.
   */
  private async integrationAlerts(now: Date): Promise<DashboardAlert[]> {
    const soon = new Date(now.getTime() + TOKEN_EXPIRING_SOON_DAYS * DAY_MS);
    const rows = await this.dataSource.query(
      `SELECT t.id AS tenant_id, t.name AS tenant_name, w.connection_status,
              w.token_expires_at
         FROM whatsapp_accounts w
         JOIN tenants t ON t.id = w."tenantId" AND t.deleted_at IS NULL
        WHERE w.deleted_at IS NULL
          AND (
            w.connection_status IN ('EXPIRED','REVOKED')
            OR (w.token_expires_at IS NOT NULL AND w.token_expires_at > $1 AND w.token_expires_at <= $2)
          )
        ORDER BY (w.connection_status IN ('EXPIRED','REVOKED')) DESC, w.token_expires_at ASC
        LIMIT ${PER_SOURCE_LIMIT}`,
      [now, soon],
    );

    return rows.map((r: Record<string, unknown>) => {
      const broken = ['EXPIRED', 'REVOKED'].includes(r.connection_status as string);
      const expiresAt = r.token_expires_at
        ? new Date(r.token_expires_at as string)
        : null;
      return {
        code: broken
          ? ALERT_CODE.INTEGRATION_TOKEN_EXPIRED
          : ALERT_CODE.INTEGRATION_TOKEN_EXPIRING,
        severity: broken ? ('critical' as const) : ('warning' as const),
        params: {
          status: r.connection_status as string,
          // An expiry is a FUTURE instant, so it belongs in params — not in
          // `occurredAt`, which the feed sorts by recency. Putting it there
          // would rank a token expiring next week above an incident that
          // happened an hour ago.
          ...(expiresAt && !broken
            ? {
                expiresAt: expiresAt.toISOString(),
                hoursRemaining: Math.max(
                  0,
                  Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000),
                ),
              }
            : {}),
        },
        entity: {
          type: 'tenant' as const,
          id: r.tenant_id as string,
          label: r.tenant_name as string,
        },
        cta: { route: `/platform/tenants/${r.tenant_id as string}` },
      };
    });
  }

  /**
   * Quota pressure, delegated to the service that owns the classification.
   *
   * `PlatformUsageService.alerts()` runs the same `buildUsageAlert` the quota
   * system and the notification system use, so a threshold never means one thing
   * here and another there. `actionableOnly` pushes a pre-filter into its SQL so
   * only rows that could raise an alert are materialised — the classification is
   * unchanged, the row count is not.
   *
   * Multiple exceeded metrics for one clinic collapse into ONE alert: an
   * operator takes a single action per clinic, so three lines would be three
   * copies of the same job.
   */
  private async quotaAlerts(): Promise<DashboardAlert[]> {
    const raw = await this.usage.alerts(undefined, { actionableOnly: true });

    const byTenant = new Map<
      string,
      { name: string; exceeded: number; warned: number; worst: number }
    >();
    for (const a of raw) {
      // Lifecycle alerts are already covered by `subscriptionAlerts` from the
      // canonical status; taking them from here too would double-count.
      if (a.metric === 'subscription') continue;
      const entry = byTenant.get(a.tenantId) ?? {
        name: a.tenantName ?? '',
        exceeded: 0,
        warned: 0,
        worst: 0,
      };
      if (a.severity === 'critical') entry.exceeded++;
      else entry.warned++;
      entry.worst = Math.max(entry.worst, a.percentUsed ?? 0);
      byTenant.set(a.tenantId, entry);
    }

    return [...byTenant.entries()]
      .sort((a, b) => b[1].exceeded - a[1].exceeded || b[1].worst - a[1].worst)
      .slice(0, PER_SOURCE_LIMIT)
      .map(([tenantId, e]) => ({
        code: e.exceeded > 0 ? ALERT_CODE.QUOTA_EXCEEDED : ALERT_CODE.QUOTA_THRESHOLD,
        severity: e.exceeded > 0 ? ('critical' as const) : ('warning' as const),
        params: {
          metricCount: e.exceeded > 0 ? e.exceeded : e.warned,
          percent: Math.round(e.worst),
        },
        entity: { type: 'tenant' as const, id: tenantId, label: e.name },
        cta: { route: '/platform/usage', query: { overLimit: 'true' } },
      }));
  }

  private async ticketAlerts(): Promise<DashboardAlert[]> {
    const kpis = await this.tickets.kpis();
    if (n(kpis.urgent) === 0) return [];
    return [
      {
        code: ALERT_CODE.TICKET_URGENT,
        severity: 'critical',
        params: { count: n(kpis.urgent) },
        cta: { route: '/platform/support-tickets' },
      },
    ];
  }

  /**
   * Infrastructure attention, from the light probe.
   *
   * Reuses `MonitoringService.healthSnapshot()` rather than its own checks, and
   * every CTA points at `/platform/monitoring` — the dashboard says something is
   * wrong, the monitoring page says what. Duplicating that page's detail here
   * would give the operator two places to read the same thing and two places to
   * keep correct.
   */
  private async infrastructureAlerts(now: Date): Promise<DashboardAlert[]> {
    const since = new Date(now.getTime() - DAY_MS);
    const h = await this.monitoring.healthSnapshot(since);
    const out: DashboardAlert[] = [];
    const cta = { route: '/platform/monitoring' };

    if (h.database === 'down') {
      out.push({ code: ALERT_CODE.DB_DOWN, severity: 'critical', params: {}, cta });
    }
    if (h.redis === 'down') {
      out.push({ code: ALERT_CODE.REDIS_DOWN, severity: 'critical', params: {}, cta });
    }
    if (h.workers === 'degraded' || h.workers === 'unknown') {
      out.push({
        code: ALERT_CODE.WORKER_STALE,
        severity: 'warning',
        params: { ageSeconds: h.workerHeartbeatAgeSeconds ?? 0, state: h.workers },
        cta,
      });
    }
    if (h.failedJobs > 0) {
      out.push({
        code: ALERT_CODE.JOBS_FAILED,
        severity: 'warning',
        params: { count: h.failedJobs },
        cta,
      });
    }
    if (h.webhookFailures > 0) {
      out.push({
        code: ALERT_CODE.WEBHOOK_FAILURES,
        severity: 'warning',
        params: { count: h.webhookFailures, hours: 24 },
        cta,
      });
    }
    return out;
  }

  private async upgradeAlerts(): Promise<DashboardAlert[]> {
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM billing_upgrade_requests
        WHERE status IN (${OPEN_UPGRADE_STATUSES.map((s) => `'${s}'`).join(',')})`,
    );
    if (n(row?.c) === 0) return [];
    return [
      {
        code: ALERT_CODE.UPGRADE_REQUEST_PENDING,
        severity: 'info',
        params: { count: n(row.c) },
        cta: { route: '/platform/billing-upgrade-requests' },
      },
    ];
  }
}
