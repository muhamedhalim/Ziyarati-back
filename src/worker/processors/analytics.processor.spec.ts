import { UnrecoverableError } from 'bullmq';

import { AnalyticsProcessor } from './analytics.processor';
import { DashboardMetricService } from '../../modules/analytics/dashboard-metric.service';
import { DailyReportService } from '../../modules/analytics/daily-report.service';
import { MonthlyReportService } from '../../modules/analytics/monthly-report.service';
import { AnalyticsRetentionService } from '../../modules/analytics/analytics-retention.service';
import { WorkerTenantsService } from '../worker-tenants.service';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { JOB } from '../../queue/queue.constants';
import { InvoiceDocumentService } from '../../modules/payments/invoice-document.service';
import { DocumentRendererService } from '../../modules/documents/document-renderer.service';
import { StorageService } from '../../modules/storage/storage.service';
import { ReportExportService } from '../../modules/report-export/report-export.service';

describe('AnalyticsProcessor', () => {
  let processor: AnalyticsProcessor;
  let dashboard: { refresh: jest.Mock };
  let daily: { generate: jest.Mock };
  let monthly: { generate: jest.Mock };
  let retention: { purgeExpiredEvents: jest.Mock };
  let tenants: { activeTenantIdsPage: jest.Mock };
  let queue: {
    enqueueAnalyticsAggregateBulk: jest.Mock;
    enqueueAnalyticsReportBulk: jest.Mock;
    enqueueAnalyticsReportMonthlyBulk: jest.Mock;
  };
  let invoiceDocuments: {
    buildDocumentData: jest.Mock;
    localeFor: jest.Mock;
    markRendered: jest.Mock;
  };
  let renderer: { render: jest.Mock };
  let storage: { upload: jest.Mock };
  let reportExport: { generateExport: jest.Mock };

  beforeEach(() => {
    dashboard = { refresh: jest.fn().mockResolvedValue({ ok: true }) };
    daily = { generate: jest.fn().mockResolvedValue({ id: 'd1' }) };
    monthly = { generate: jest.fn().mockResolvedValue({ id: 'm1' }) };
    retention = {
      purgeExpiredEvents: jest.fn().mockResolvedValue({ purged: 5 }),
    };
    tenants = {
      activeTenantIdsPage: jest
        .fn()
        .mockResolvedValueOnce(['t1', 't2'])
        .mockResolvedValue([]),
    };
    queue = {
      enqueueAnalyticsAggregateBulk: jest.fn().mockResolvedValue(undefined),
      enqueueAnalyticsReportBulk: jest.fn().mockResolvedValue(undefined),
      enqueueAnalyticsReportMonthlyBulk: jest.fn().mockResolvedValue(undefined),
    };
    invoiceDocuments = {
      buildDocumentData: jest
        .fn()
        .mockResolvedValue({ invoiceNumber: 'INV-1' }),
      localeFor: jest.fn().mockResolvedValue('en'),
      markRendered: jest.fn().mockResolvedValue(undefined),
    };
    renderer = {
      render: jest.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
    };
    storage = {
      upload: jest.fn().mockResolvedValue({ storageKey: 't1/invoices/x.pdf' }),
    };
    reportExport = {
      generateExport: jest.fn().mockResolvedValue(undefined),
    };
    processor = new AnalyticsProcessor(
      dashboard as unknown as DashboardMetricService,
      daily as unknown as DailyReportService,
      monthly as unknown as MonthlyReportService,
      retention as unknown as AnalyticsRetentionService,
      tenants as unknown as WorkerTenantsService,
      queue as unknown as QueueService,
      new TenantContextService(),
      { assertAuthorized: jest.fn().mockResolvedValue(undefined) } as any,
      invoiceDocuments as unknown as InvoiceDocumentService,
      renderer as unknown as DocumentRendererService,
      storage as unknown as StorageService,
      reportExport as unknown as ReportExportService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('aggregate sweep pages through tenants and bulk-enqueues each page (M7)', async () => {
    const res = await processor.process({
      name: JOB.ANALYTICS_AGGREGATE,
      data: { tenantId: null },
    } as any);
    expect(queue.enqueueAnalyticsAggregateBulk).toHaveBeenCalledTimes(1);
    expect(queue.enqueueAnalyticsAggregateBulk).toHaveBeenCalledWith([
      't1',
      't2',
    ]);
    expect(res).toEqual({ fannedOut: 2 });
  });

  it('aggregate per-tenant refreshes the dashboard', async () => {
    await processor.process({
      name: JOB.ANALYTICS_AGGREGATE,
      data: { tenantId: 't1' },
    } as any);
    expect(dashboard.refresh).toHaveBeenCalledWith('t1');
  });

  it('cleanup purges expired analytics events', async () => {
    const res = await processor.process({
      name: JOB.ANALYTICS_CLEANUP,
      data: {},
    } as any);
    expect(retention.purgeExpiredEvents).toHaveBeenCalled();
    expect(res).toEqual({ purged: 5 });
  });

  it('generateReport sweep pages through tenants and bulk-enqueues daily reports (M7)', async () => {
    const res = await processor.process({
      name: JOB.ANALYTICS_GENERATE_REPORT,
      data: { tenantId: null, date: '2026-07-01' },
    } as any);
    expect(queue.enqueueAnalyticsReportBulk).toHaveBeenCalledTimes(1);
    expect(queue.enqueueAnalyticsReportBulk).toHaveBeenCalledWith([
      { tenantId: 't1', date: '2026-07-01' },
      { tenantId: 't2', date: '2026-07-01' },
    ]);
    expect(res).toMatchObject({ fannedOut: 2 });
  });

  it('aggregate sweep continues to a second page when the first page is full-sized (M7)', async () => {
    const fullPage = Array.from({ length: 500 }, (_, i) => `t${i}`);
    tenants.activeTenantIdsPage.mockReset();
    tenants.activeTenantIdsPage
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(['t500'])
      .mockResolvedValue([]);

    const res = await processor.process({
      name: JOB.ANALYTICS_AGGREGATE,
      data: { tenantId: null },
    } as any);

    expect(tenants.activeTenantIdsPage).toHaveBeenCalledWith(0, 500);
    expect(tenants.activeTenantIdsPage).toHaveBeenCalledWith(500, 500);
    expect(queue.enqueueAnalyticsAggregateBulk).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ fannedOut: 501 });
  });

  it('generateReport per-tenant monthly delegates to MonthlyReportService', async () => {
    await processor.process({
      name: JOB.ANALYTICS_GENERATE_REPORT,
      data: { tenantId: 't1', kind: 'monthly', month: '2026-07' },
    } as any);
    expect(monthly.generate).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ month: '2026-07' }),
      { skipWhenNoActiveBranches: true },
    );
  });

  /**
   * Root cause of the permanent red "failed" count on /platform/monitoring:
   * the nightly sweep fans out to a tenant with no active branch, generate()
   * threw a 422, BullMQ retried it 5x and parked it in `failed` every night
   * (prod job ids analytics-daily-<tenant>-<date>, 2026-10-14 … 2026-10-21).
   */
  it('generateReport per-tenant daily for a tenant with no active branch completes as a recorded skip', async () => {
    const skipped = { generated: [], failed: [], skipped: 'no_active_branches' };
    daily.generate.mockResolvedValueOnce(skipped);
    await expect(
      processor.process({
        name: JOB.ANALYTICS_GENERATE_REPORT,
        data: { tenantId: 't1', kind: 'daily', date: '2026-10-21' },
      } as any),
    ).resolves.toEqual(skipped);
    expect(daily.generate).toHaveBeenCalledWith(
      't1',
      { date: '2026-10-21', branchId: undefined },
      { skipWhenNoActiveBranches: true },
    );
  });

  it('generateReport per-tenant monthly for a tenant with no active branch completes as a recorded skip', async () => {
    const skipped = { generated: [], failed: [], skipped: 'no_active_branches' };
    monthly.generate.mockResolvedValueOnce(skipped);
    await expect(
      processor.process({
        name: JOB.ANALYTICS_GENERATE_REPORT,
        data: { tenantId: 't1', kind: 'monthly', month: '2026-10' },
      } as any),
    ).resolves.toEqual(skipped);
  });

  it('generateReport still throws a real (transient) error so BullMQ retries and, if exhausted, records it as failed', async () => {
    daily.generate.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.1:5432'));
    await expect(
      processor.process({
        name: JOB.ANALYTICS_GENERATE_REPORT,
        data: { tenantId: 't1', kind: 'daily', date: '2026-10-21' },
      } as any),
    ).rejects.toThrow('ECONNREFUSED');
  });

  /**
   * FND-014 — before the fix, a `kind: 'monthly'` sweep (tenantId null) fell
   * through to the DAILY sweep unconditionally (it never inspected `kind`),
   * silently fanning out `kind: 'daily'` per-tenant jobs for "yesterday"
   * instead of monthly reports for the completed month. Fails today because
   * `enqueueAnalyticsReportMonthlyBulk` is never called.
   */
  it('generateReport monthly sweep pages through tenants and bulk-enqueues monthly reports for the explicit month (FND-014)', async () => {
    const res = await processor.process({
      name: JOB.ANALYTICS_GENERATE_REPORT,
      data: { tenantId: null, kind: 'monthly', month: '2026-07' },
    } as any);
    expect(queue.enqueueAnalyticsReportMonthlyBulk).toHaveBeenCalledTimes(1);
    expect(queue.enqueueAnalyticsReportMonthlyBulk).toHaveBeenCalledWith([
      { tenantId: 't1', month: '2026-07' },
      { tenantId: 't2', month: '2026-07' },
    ]);
    expect(queue.enqueueAnalyticsReportBulk).not.toHaveBeenCalled();
    expect(res).toMatchObject({ fannedOut: 2, month: '2026-07' });
  });

  it('generateReport monthly sweep defaults to the completed UTC month when none is given (FND-014)', async () => {
    const fixed = new Date('2026-08-01T00:35:00.000Z');
    jest.useFakeTimers().setSystemTime(fixed);
    try {
      const res = await processor.process({
        name: JOB.ANALYTICS_GENERATE_REPORT,
        data: { tenantId: null, kind: 'monthly' },
      } as any);
      // Timezone-explicit (UTC), not server-local: fires just after month
      // rollover, targets the month that JUST completed.
      expect(queue.enqueueAnalyticsReportMonthlyBulk).toHaveBeenCalledWith([
        { tenantId: 't1', month: '2026-07' },
        { tenantId: 't2', month: '2026-07' },
      ]);
      expect(res).toMatchObject({ fannedOut: 2, month: '2026-07' });
    } finally {
      jest.useRealTimers();
    }
  });

  describe('T183 — analytics.exportGenerate job routing', () => {
    it('delegates to ReportExportService.generateExport, never touching report generation', async () => {
      await processor.process({
        name: JOB.ANALYTICS_EXPORT_GENERATE,
        data: { tenantId: 't1', exportJobId: 'job-1' },
      } as any);

      expect(reportExport.generateExport).toHaveBeenCalledWith('t1', 'job-1');
      expect(daily.generate).not.toHaveBeenCalled();
      expect(monthly.generate).not.toHaveBeenCalled();
    });

    it('throws (payload guard) when exportJobId is missing, never reaching the service', async () => {
      await expect(
        processor.process({
          name: JOB.ANALYTICS_EXPORT_GENERATE,
          data: { tenantId: 't1' },
        } as any),
      ).rejects.toThrow();
      expect(reportExport.generateExport).not.toHaveBeenCalled();
    });
  });

  describe('T095 — analytics.invoiceDocument job routing', () => {
    it('renders, uploads and persists the document key/version, never touching report generation', async () => {
      const res = await processor.process({
        name: JOB.ANALYTICS_INVOICE_DOCUMENT,
        data: { tenantId: 't1', invoiceId: 'inv-1', documentVersion: 2 },
      } as any);

      expect(invoiceDocuments.buildDocumentData).toHaveBeenCalledWith(
        't1',
        'inv-1',
      );
      expect(invoiceDocuments.localeFor).toHaveBeenCalledWith('t1');
      expect(renderer.render).toHaveBeenCalled();
      expect(storage.upload).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          mimeType: 'application/pdf',
        }),
      );
      expect(invoiceDocuments.markRendered).toHaveBeenCalledWith(
        't1',
        'inv-1',
        2,
        't1/invoices/x.pdf',
      );
      expect(res).toEqual({ documentKey: 't1/invoices/x.pdf' });
      expect(daily.generate).not.toHaveBeenCalled();
      expect(monthly.generate).not.toHaveBeenCalled();
    });

    /**
     * T095's own regression guard: `AnalyticsProcessor.process` used to be
     * an if-chain whose final fall-through treated ANY unmatched job name
     * as `analytics.generateReport`. A new job name added without its own
     * branch must fail loudly (UnrecoverableError), never silently execute
     * report generation against a mismatched payload.
     */
    it('an unknown job name throws UnrecoverableError instead of falling through to report generation', async () => {
      await expect(
        processor.process({
          name: 'analytics.someFutureJobNobodyBranchedOn',
          data: { tenantId: 't1' },
        } as any),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(daily.generate).not.toHaveBeenCalled();
      expect(monthly.generate).not.toHaveBeenCalled();
    });

    it('analytics.generateReport itself still routes correctly alongside the new branch', async () => {
      await processor.process({
        name: JOB.ANALYTICS_GENERATE_REPORT,
        data: { tenantId: 't1', date: '2026-07-01' },
      } as any);
      expect(daily.generate).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ date: '2026-07-01' }),
        { skipWhenNoActiveBranches: true },
      );
    });
  });
});
