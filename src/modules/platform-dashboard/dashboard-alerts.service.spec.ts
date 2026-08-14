import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import {
  ALERT_CODE,
  DashboardAlertsService,
  type AlertCode,
} from './dashboard-alerts.service';
import { MonitoringService } from '../platform-monitoring/monitoring.service';
import { SupportTicketService } from '../support-tickets/support-ticket.service';
import { PlatformUsageService } from '../platform-usage/platform-usage.service';

const HEALTHY = {
  database: 'up',
  redis: 'up',
  workers: 'up',
  workerHeartbeatAgeSeconds: 5,
  queueBacklog: 0,
  failedJobs: 0,
  webhookFailures: 0,
};

const QUIET: Record<string, Record<string, unknown>[]> = {
  tenants: [{ pending_approval: 0, pending_docs: 0 }],
  subs: [
    {
      expiring_active: 0,
      expiring_trial: 0,
      past_due: 0,
      grace_expired: 0,
      no_subscription: 0,
    },
  ],
  payments: [{ failed: 0, amount: 0 }],
  integrations: [],
  upgrades: [{ c: 0 }],
};

function build(over: Partial<typeof QUIET> = {}, extra: Record<string, unknown> = {}) {
  const data = { ...QUIET, ...over };
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('pending_approval')) return data.tenants;
    if (sql.includes('expiring_active')) return data.subs;
    if (sql.includes("status = 'FAILED'")) return data.payments;
    if (sql.includes('whatsapp_accounts')) return data.integrations;
    if (sql.includes('billing_upgrade_requests')) return data.upgrades;
    return [];
  });

  const service = new DashboardAlertsService(
    { query } as unknown as DataSource,
    { get: jest.fn().mockReturnValue(14) } as unknown as ConfigService,
    {
      healthSnapshot: jest.fn().mockResolvedValue(extra.health ?? HEALTHY),
    } as unknown as MonitoringService,
    {
      kpis: jest.fn().mockResolvedValue(extra.tickets ?? { urgent: 0, open: 0 }),
    } as unknown as SupportTicketService,
    {
      alerts: jest.fn().mockResolvedValue(extra.quota ?? []),
    } as unknown as PlatformUsageService,
  );
  return { service, query };
}

const codes = (alerts: { code: AlertCode }[]) => alerts.map((a) => a.code);

describe('DashboardAlertsService', () => {
  it('returns an empty feed with zero counts when nothing needs attention', async () => {
    const { service } = build();
    const r = await service.alerts();

    expect(r.alerts).toEqual([]);
    expect(r.totalBySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(r.truncated).toBe(false);
    expect(r.degradedSources).toEqual([]);
  });

  it('never composes English prose — every alert is a code plus params', async () => {
    const { service } = build(
      { tenants: [{ pending_approval: 3, pending_docs: 2 }] },
      { tickets: { urgent: 1, open: 4 } },
    );
    const r = await service.alerts();

    expect(r.alerts.length).toBeGreaterThan(0);
    for (const a of r.alerts) {
      expect(a.code).toMatch(/^[A-Z_]+$/);
      expect(a).not.toHaveProperty('message');
      // Params carry values for client-side interpolation, never a sentence.
      for (const v of Object.values(a.params)) {
        expect(['string', 'number']).toContain(typeof v);
      }
    }
  });

  it('ranks critical before warning before info', async () => {
    const { service } = build(
      {
        tenants: [{ pending_approval: 1, pending_docs: 0 }],
        subs: [
          {
            expiring_active: 0,
            expiring_trial: 0,
            past_due: 0,
            grace_expired: 2,
            no_subscription: 5,
          },
        ],
      },
      { tickets: { urgent: 1, open: 1 } },
    );
    const r = await service.alerts();

    const severities = r.alerts.map((a) => a.severity);
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(rank[severities[i - 1]]);
    }
    expect(severities[0]).toBe('critical');
  });

  it('gives every alert a CTA route so the feed is actionable, not informational', async () => {
    const { service } = build(
      { tenants: [{ pending_approval: 2, pending_docs: 1 }] },
      { health: { ...HEALTHY, failedJobs: 3 }, tickets: { urgent: 1, open: 0 } },
    );
    const r = await service.alerts();

    expect(r.alerts.length).toBeGreaterThan(0);
    for (const a of r.alerts) {
      expect(a.cta.route).toMatch(/^\/platform\//);
    }
  });

  it('routes each alert to the page where the operator can act', async () => {
    const { service } = build({ tenants: [{ pending_approval: 2, pending_docs: 1 }] });
    const r = await service.alerts();

    const approval = r.alerts.find((a) => a.code === ALERT_CODE.TENANT_PENDING_APPROVAL)!;
    expect(approval.cta).toEqual({
      route: '/platform/tenants',
      query: { status: 'PENDING_APPROVAL' },
    });
  });

  it('degrades a single source rather than the whole feed', async () => {
    const { service } = build();
    (service as unknown as { monitoring: MonitoringService }).monitoring = {
      healthSnapshot: jest.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as MonitoringService;

    const r = await service.alerts();

    // A cached or blank "all clear" during an incident is worse than a partial
    // list that says which check is missing.
    expect(r.degradedSources).toContain('infrastructure');
    expect(r.alerts).toEqual([]);
  });

  it('collapses several exceeded quotas for one clinic into one alert', async () => {
    const { service } = build(
      {},
      {
        quota: [
          { tenantId: 't1', tenantName: 'Al-Noor', metric: 'aiTokens', severity: 'critical', percentUsed: 140 },
          { tenantId: 't1', tenantName: 'Al-Noor', metric: 'appointments', severity: 'critical', percentUsed: 118 },
          { tenantId: 't1', tenantName: 'Al-Noor', metric: 'campaigns', severity: 'warning', percentUsed: 85 },
        ],
      },
    );
    const r = await service.alerts();

    const quota = r.alerts.filter((a) => a.code === ALERT_CODE.QUOTA_EXCEEDED);
    // One clinic, one operator action — three lines would be three copies of
    // the same job.
    expect(quota).toHaveLength(1);
    expect(quota[0].params.metricCount).toBe(2);
    expect(quota[0].params.percent).toBe(140);
    expect(quota[0].entity).toEqual({ type: 'tenant', id: 't1', label: 'Al-Noor' });
  });

  it('asks the usage service only for actionable rows', async () => {
    const usageAlerts = jest.fn().mockResolvedValue([]);
    const { service } = build();
    (service as unknown as { usage: PlatformUsageService }).usage = {
      alerts: usageAlerts,
    } as unknown as PlatformUsageService;

    await service.alerts();

    // The unfiltered call materialises every subscription row in Node — fine
    // for the usage page, far too much for a landing page.
    expect(usageAlerts).toHaveBeenCalledWith(undefined, { actionableOnly: true });
  });

  it('does not double-count subscription lifecycle from the quota source', async () => {
    const { service } = build(
      {
        subs: [
          {
            expiring_active: 0,
            expiring_trial: 0,
            past_due: 1,
            grace_expired: 0,
            no_subscription: 0,
          },
        ],
      },
      {
        quota: [
          { tenantId: 't1', tenantName: 'A', metric: 'subscription', severity: 'warning', percentUsed: null },
        ],
      },
    );
    const r = await service.alerts();

    // Lifecycle is already reported from the canonical status; the usage
    // service's own lifecycle pseudo-metric would be a second copy.
    expect(codes(r.alerts).filter((c) => c === ALERT_CODE.QUOTA_THRESHOLD)).toHaveLength(0);
    expect(codes(r.alerts)).toContain(ALERT_CODE.SUBSCRIPTION_PAST_DUE);
  });

  it('flags a revoked integration as critical and names the clinic, never the token', async () => {
    const { service } = build({
      integrations: [
        {
          tenant_id: 't9',
          tenant_name: 'Al-Shifa',
          connection_status: 'REVOKED',
          token_expires_at: null,
        },
      ],
    });
    const r = await service.alerts();

    const a = r.alerts.find((x) => x.code === ALERT_CODE.INTEGRATION_TOKEN_EXPIRED)!;
    expect(a.severity).toBe('critical');
    expect(a.entity).toEqual({ type: 'tenant', id: 't9', label: 'Al-Shifa' });
    expect(a.cta.route).toBe('/platform/tenants/t9');
    // The connection STATE is reportable; the credential and Meta identifiers
    // are not. Asserted on field names rather than the substring "token", which
    // legitimately appears in the alert code itself.
    expect(a.params).toEqual({ status: 'REVOKED' });
    // A broken connection is already broken — there is no countdown to report.
    expect(a.occurredAt).toBeUndefined();
    const serialized = JSON.stringify(a);
    for (const secret of ['access_token', 'waba_id', 'phone_number_id', 'token_expires_at']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('raises infrastructure alerts from the light probe and sends them to monitoring', async () => {
    const { service } = build(
      {},
      {
        health: {
          ...HEALTHY,
          database: 'down',
          workers: 'degraded',
          failedJobs: 3,
          webhookFailures: 7,
        },
      },
    );
    const r = await service.alerts();

    expect(codes(r.alerts)).toEqual(
      expect.arrayContaining([
        ALERT_CODE.DB_DOWN,
        ALERT_CODE.WORKER_STALE,
        ALERT_CODE.JOBS_FAILED,
        ALERT_CODE.WEBHOOK_FAILURES,
      ]),
    );
    // The dashboard says something is wrong; /platform/monitoring says what.
    for (const a of r.alerts) expect(a.cta.route).toBe('/platform/monitoring');
  });

  it('caps the feed and reports truncation with full severity totals', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      tenant_id: `t${i}`,
      tenant_name: `Clinic ${i}`,
      connection_status: 'REVOKED',
      token_expires_at: null,
    }));
    const { service } = build({ integrations: many });
    const r = await service.alerts();

    expect(r.alerts.length).toBeLessThanOrEqual(50);
    expect(r.truncated).toBe(true);
    // `totalBySeverity` deliberately counts EVERYTHING found, not just the
    // visible slice — that is what lets the UI say "showing 50 of 80" instead
    // of quietly implying 50 is the whole picture.
    expect(r.totalBySeverity.critical).toBe(80);
  });

  it('exposes no clinic PII beyond an id and a display name', async () => {
    const { service } = build({
      integrations: [
        {
          tenant_id: 't1',
          tenant_name: 'Al-Noor',
          connection_status: 'EXPIRED',
          token_expires_at: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    });
    const r = await service.alerts();

    const serialized = JSON.stringify(r);
    for (const forbidden of ['contact_email', 'contact_phone', 'access_token', 'ip_address']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('ALERT_CODE registry', () => {
  it('every code is a stable screaming-snake identifier', () => {
    for (const [key, value] of Object.entries(ALERT_CODE)) {
      expect(value).toBe(key);
      expect(value).toMatch(/^[A-Z][A-Z_]*$/);
    }
  });
});
