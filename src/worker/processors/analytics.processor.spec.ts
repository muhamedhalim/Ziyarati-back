import { AnalyticsProcessor } from './analytics.processor';
import { DashboardMetricService } from '../../modules/analytics/dashboard-metric.service';
import { DailyReportService } from '../../modules/analytics/daily-report.service';
import { MonthlyReportService } from '../../modules/analytics/monthly-report.service';
import { AnalyticsRetentionService } from '../../modules/analytics/analytics-retention.service';
import { WorkerTenantsService } from '../worker-tenants.service';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { JOB } from '../../queue/queue.constants';

describe('AnalyticsProcessor', () => {
  let processor: AnalyticsProcessor;
  let dashboard: { refresh: jest.Mock };
  let daily: { generate: jest.Mock };
  let monthly: { generate: jest.Mock };
  let retention: { purgeExpiredEvents: jest.Mock };
  let tenants: { activeTenantIds: jest.Mock };
  let queue: { enqueueAnalyticsAggregate: jest.Mock; enqueueAnalyticsReport: jest.Mock };

  beforeEach(() => {
    dashboard = { refresh: jest.fn().mockResolvedValue({ ok: true }) };
    daily = { generate: jest.fn().mockResolvedValue({ id: 'd1' }) };
    monthly = { generate: jest.fn().mockResolvedValue({ id: 'm1' }) };
    retention = { purgeExpiredEvents: jest.fn().mockResolvedValue({ purged: 5 }) };
    tenants = { activeTenantIds: jest.fn().mockResolvedValue(['t1', 't2']) };
    queue = {
      enqueueAnalyticsAggregate: jest.fn().mockResolvedValue(undefined),
      enqueueAnalyticsReport: jest.fn().mockResolvedValue(undefined),
    };
    processor = new AnalyticsProcessor(
      dashboard as unknown as DashboardMetricService,
      daily as unknown as DailyReportService,
      monthly as unknown as MonthlyReportService,
      retention as unknown as AnalyticsRetentionService,
      tenants as unknown as WorkerTenantsService,
      queue as unknown as QueueService,
      new TenantContextService(),
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('aggregate sweep fans out per active tenant', async () => {
    const res = await processor.process({ name: JOB.ANALYTICS_AGGREGATE, data: { tenantId: null } } as any);
    expect(queue.enqueueAnalyticsAggregate).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ fannedOut: 2 });
  });

  it('aggregate per-tenant refreshes the dashboard', async () => {
    await processor.process({ name: JOB.ANALYTICS_AGGREGATE, data: { tenantId: 't1' } } as any);
    expect(dashboard.refresh).toHaveBeenCalledWith('t1');
  });

  it('cleanup purges expired analytics events', async () => {
    const res = await processor.process({ name: JOB.ANALYTICS_CLEANUP, data: {} } as any);
    expect(retention.purgeExpiredEvents).toHaveBeenCalled();
    expect(res).toEqual({ purged: 5 });
  });

  it('generateReport sweep fans out daily reports per tenant', async () => {
    const res = await processor.process({
      name: JOB.ANALYTICS_GENERATE_REPORT,
      data: { tenantId: null, date: '2026-07-01' },
    } as any);
    expect(queue.enqueueAnalyticsReport).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ fannedOut: 2 });
  });

  it('generateReport per-tenant monthly delegates to MonthlyReportService', async () => {
    await processor.process({
      name: JOB.ANALYTICS_GENERATE_REPORT,
      data: { tenantId: 't1', kind: 'monthly', month: '2026-07' },
    } as any);
    expect(monthly.generate).toHaveBeenCalledWith('t1', expect.objectContaining({ month: '2026-07' }));
  });
});
