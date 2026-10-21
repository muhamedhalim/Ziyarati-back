import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { IsOptional, IsString } from 'class-validator';

import { ExportJob } from '../../entities/System/ExportJob';
import { ExportJobState } from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

import { ReportExportService } from './report-export.service';
import { AdvancedAnalyticsService } from '../analytics/advanced-analytics.service';
import { DailyReportService } from '../analytics/daily-report.service';
import { MonthlyReportService } from '../analytics/monthly-report.service';
import { StaffPerformanceService } from '../analytics/staff-performance.service';
import { AnalyticsAggregationService } from '../analytics/analytics-aggregation.service';
import { XlsxWriterService } from './xlsx-writer.service';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../../queue/queue.service';
import { ReportExportAuditService } from './report-export-audit.service';

class TestFiltersDto {
  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;
}

// One controlled, fully synthetic registry entry — keeps this suite focused
// on ReportExportService's OWN orchestration (threshold, frozen scope,
// claim, audit, expiry), independent of any real analytics query body.
// `export-registry.spec.ts` separately proves the REAL registry's entries
// reference the real literal service methods.
const mockQuery = jest.fn();
const mockEntry = {
  key: 'staff-performance' as const,
  label: 'Test Report',
  formats: ['XLSX'] as const,
  columns: [{ key: 'name', header: 'Name' }],
  argsDto: TestFiltersDto,
  query: mockQuery,
  toArgs: (ctx: { tenantId: string; filters: Record<string, unknown> }) => [
    ctx.tenantId,
    ctx.filters,
  ],
  serializeRow: (row: Record<string, unknown>) => row,
  paginated: false,
};

jest.mock('./export-registry', () => {
  const actual = jest.requireActual('./export-registry');
  return {
    ...actual,
    isExportableReportKey: (key: string) => key === 'staff-performance',
    getExportRegistryEntry: () => mockEntry,
    extractRows: actual.extractRows,
  };
});

describe('ReportExportService (T181/T183/T184)', () => {
  let service: ReportExportService;
  let exportJobs: MockRepository & {
    query: jest.Mock;
    findOneOrFail: jest.Mock;
  };
  let advanced: { resolveScope: jest.Mock; reportingTimezone: jest.Mock };
  let storage: {
    upload: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
    deleteObject: jest.Mock;
  };
  let queue: { enqueueAnalyticsExportGenerate: jest.Mock };
  let audit: {
    recordRequested: jest.Mock;
    recordCompleted: jest.Mock;
  };

  const USER = {
    id: 'user-1',
    tenantId: 'tenant-1',
    roles: [],
    permissions: [],
  };

  beforeEach(async () => {
    mockQuery.mockReset();
    exportJobs = Object.assign(createMockRepository(), {
      query: jest.fn(),
      findOneOrFail: jest.fn(),
    });
    advanced = {
      resolveScope: jest.fn().mockResolvedValue({}),
      reportingTimezone: jest.fn().mockResolvedValue('UTC'),
    };
    storage = {
      upload: jest
        .fn()
        .mockResolvedValue({ storageKey: 'tenant-1/exports/x.xlsx' }),
      getSignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/x'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    queue = {
      enqueueAnalyticsExportGenerate: jest.fn().mockResolvedValue(undefined),
    };
    audit = {
      recordRequested: jest.fn().mockResolvedValue(undefined),
      recordCompleted: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReportExportService,
        { provide: getRepositoryToken(ExportJob), useValue: exportJobs },
        { provide: AdvancedAnalyticsService, useValue: advanced },
        { provide: DailyReportService, useValue: {} },
        { provide: MonthlyReportService, useValue: {} },
        { provide: StaffPerformanceService, useValue: {} },
        {
          provide: AnalyticsAggregationService,
          useValue: {
            resolveReportingCurrency: jest.fn().mockResolvedValue({
              currency: 'SAR',
              configuredCurrency: 'SAR',
            }),
          },
        },
        XlsxWriterService,
        { provide: StorageService, useValue: storage },
        { provide: QueueService, useValue: queue },
        { provide: ReportExportAuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(ReportExportService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('requestExport', () => {
    it('rejects an unknown report key', async () => {
      await expect(
        service.requestExport('tenant-1', USER, {
          report: 'not-a-real-report',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('rejects a format the registry entry does not support', async () => {
      await expect(
        service.requestExport('tenant-1', USER, {
          report: 'staff-performance',
          format: 'PDF',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('returns the file directly (sync) below the row threshold, and records both audit stages', async () => {
      mockQuery.mockResolvedValueOnce([{ name: 'Alice' }, { name: 'Bob' }]);

      const result = await service.requestExport('tenant-1', USER, {
        report: 'staff-performance',
        filters: { from: '2026-01-01', to: '2026-01-31' },
      });

      expect(result.kind).toBe('sync');
      if (result.kind === 'sync') {
        expect(result.buffer.length).toBeGreaterThan(0);
      }
      expect(audit.recordRequested).toHaveBeenCalledTimes(1);
      expect(audit.recordCompleted).toHaveBeenCalledTimes(1);
      expect(audit.recordCompleted.mock.calls[0][4]).toBe(2); // rowCount
      // No ExportJob row is persisted for the synchronous path.
      expect(exportJobs.save).not.toHaveBeenCalled();
    });

    it('captures branch scope at request time and NEVER re-resolves it for generation (frozen scope)', async () => {
      advanced.resolveScope.mockResolvedValueOnce({ branchId: 'branch-9' });
      mockQuery.mockResolvedValueOnce([{ name: 'Alice' }]);

      await service.requestExport('tenant-1', USER, {
        report: 'staff-performance',
        filters: { branchId: 'branch-9' },
      });

      // resolveScope is called exactly ONCE — at request time. The generation
      // path (exercised in the async/claim tests below) never calls it again.
      expect(advanced.resolveScope).toHaveBeenCalledTimes(1);
    });

    it('creates a PENDING ExportJob with frozen filters/branch_scope and enqueues generation above the threshold', async () => {
      advanced.resolveScope.mockResolvedValueOnce({ branchId: 'branch-9' });
      const bigPage = Array.from({ length: 1001 }, (_, i) => ({
        name: `Row ${i}`,
      }));
      mockQuery.mockResolvedValueOnce(bigPage);
      exportJobs.save.mockImplementationOnce(async (e: unknown) => ({
        ...(e as object),
        id: 'job-1',
      }));

      const result = await service.requestExport('tenant-1', USER, {
        report: 'staff-performance',
        filters: { branchId: 'branch-9' },
      });

      expect(result.kind).toBe('async');
      if (result.kind === 'async') expect(result.jobId).toBe('job-1');

      expect(exportJobs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          report: 'staff-performance',
          state: ExportJobState.PENDING,
          branch_scope: { branchId: 'branch-9' },
          filters: expect.objectContaining({ branchId: 'branch-9' }),
        }),
      );
      expect(queue.enqueueAnalyticsExportGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', exportJobId: 'job-1' }),
      );
      expect(audit.recordRequested).toHaveBeenCalledWith(
        'tenant-1',
        'job-1',
        'staff-performance',
        expect.anything(),
        'user-1',
      );
    });
  });

  describe('getStatus / getDownload (T184)', () => {
    it('throws NOT_FOUND for an unknown or cross-tenant job id', async () => {
      exportJobs.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getStatus('tenant-1', 'missing'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('returns a signed URL for a READY job', async () => {
      exportJobs.findOne.mockResolvedValueOnce({
        id: 'job-1',
        state: ExportJobState.READY,
        storage_key: 'tenant-1/exports/x.xlsx',
      });
      const result = await service.getDownload('tenant-1', 'job-1');
      expect(result).toEqual({
        pending: false,
        url: 'https://signed.example/x',
      });
    });

    it('returns pending:true for PENDING/RUNNING, never an error', async () => {
      exportJobs.findOne.mockResolvedValueOnce({
        id: 'job-1',
        state: ExportJobState.RUNNING,
      });
      const result = await service.getDownload('tenant-1', 'job-1');
      expect(result).toEqual({ pending: true, state: ExportJobState.RUNNING });
    });

    it('throws CONFLICT with the state for an EXPIRED job', async () => {
      exportJobs.findOne.mockResolvedValueOnce({
        id: 'job-1',
        state: ExportJobState.EXPIRED,
      });
      await expect(
        service.getDownload('tenant-1', 'job-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { state: ExportJobState.EXPIRED },
      });
    });

    it('throws CONFLICT with the state for a FAILED job', async () => {
      exportJobs.findOne.mockResolvedValueOnce({
        id: 'job-1',
        state: ExportJobState.FAILED,
      });
      await expect(
        service.getDownload('tenant-1', 'job-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
        publicContext: { state: ExportJobState.FAILED },
      });
    });
  });

  describe('generateExport — claim (T183)', () => {
    it('is a no-op when the job is already handled (not PENDING anymore)', async () => {
      exportJobs.query.mockResolvedValueOnce([]); // conditional UPDATE affected 0 rows
      exportJobs.findOne.mockResolvedValueOnce({
        id: 'job-1',
        state: ExportJobState.READY,
      });

      await service.generateExport('tenant-1', 'job-1');

      expect(exportJobs.query).toHaveBeenCalledTimes(1);
      // findOneOrFail (the generation path) is never reached.
      expect(exportJobs.findOneOrFail).not.toHaveBeenCalled();
    });

    it('throws a retryable error when the per-tenant concurrency cap is reached', async () => {
      exportJobs.query.mockResolvedValueOnce([]); // conditional UPDATE affected 0 rows
      exportJobs.findOne.mockResolvedValueOnce({
        id: 'job-1',
        state: ExportJobState.PENDING, // still pending → cap must be the reason
      });

      await expect(service.generateExport('tenant-1', 'job-1')).rejects.toThrow(
        /concurrency cap/,
      );
    });

    it('claims PENDING → RUNNING via a single conditional UPDATE, generates, uploads, and marks READY', async () => {
      exportJobs.query.mockResolvedValueOnce([{ id: 'job-1' }]); // claimed
      exportJobs.findOneOrFail = jest.fn().mockResolvedValueOnce({
        id: 'job-1',
        report: 'staff-performance',
        filters: { branchId: 'branch-9' },
        branch_scope: { branchId: 'branch-9' },
        requestedBy: { id: 'user-1' },
      });
      mockQuery.mockResolvedValueOnce([{ name: 'Alice' }]);

      await service.generateExport('tenant-1', 'job-1');

      // Generation never re-resolves the caller's current scope — it reads
      // ONLY the frozen job.branch_scope/filters (advanced.resolveScope is
      // request-time only, not called at all here).
      expect(advanced.resolveScope).not.toHaveBeenCalled();
      expect(storage.upload).toHaveBeenCalledTimes(1);
      expect(exportJobs.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        expect.objectContaining({ state: ExportJobState.READY, row_count: 1 }),
      );
      expect(audit.recordCompleted).toHaveBeenCalledTimes(1);
    });

    it('marks the job FAILED with the error message on a generation failure', async () => {
      exportJobs.query.mockResolvedValueOnce([{ id: 'job-1' }]);
      exportJobs.findOneOrFail = jest.fn().mockResolvedValueOnce({
        id: 'job-1',
        report: 'staff-performance',
        filters: {},
        branch_scope: null,
      });
      mockQuery.mockRejectedValueOnce(new Error('boom'));

      await expect(service.generateExport('tenant-1', 'job-1')).rejects.toThrow(
        'boom',
      );
      expect(exportJobs.update).toHaveBeenCalledWith(
        { id: 'job-1' },
        expect.objectContaining({ state: ExportJobState.FAILED }),
      );
    });
  });

  describe('expireDueExports (T183)', () => {
    it('deletes the storage object BEFORE marking the job EXPIRED', async () => {
      const callOrder: string[] = [];
      storage.deleteObject.mockImplementationOnce(async () => {
        callOrder.push('delete');
      });
      exportJobs.update.mockImplementationOnce(async () => {
        callOrder.push('update');
        return { affected: 1 };
      });
      exportJobs.find
        .mockResolvedValueOnce([
          {
            id: 'job-1',
            state: ExportJobState.READY,
            storage_key: 'tenant-1/exports/x.xlsx',
            expires_at: new Date(Date.now() - 1000),
            tenant: { id: 'tenant-1' },
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.expireDueExports();

      expect(result.expired).toBe(1);
      expect(callOrder).toEqual(['delete', 'update']);
    });

    it('leaves a job READY (does not mark EXPIRED) if the storage delete fails', async () => {
      storage.deleteObject.mockRejectedValueOnce(new Error('r2 down'));
      exportJobs.find.mockResolvedValueOnce([
        {
          id: 'job-1',
          state: ExportJobState.READY,
          storage_key: 'tenant-1/exports/x.xlsx',
          expires_at: new Date(Date.now() - 1000),
          tenant: { id: 'tenant-1' },
        },
      ]);

      const result = await service.expireDueExports();

      expect(result.expired).toBe(0);
      expect(exportJobs.update).not.toHaveBeenCalled();
    });

    it('does nothing when no jobs are due yet', async () => {
      exportJobs.find.mockResolvedValueOnce([
        {
          id: 'job-1',
          state: ExportJobState.READY,
          storage_key: 'k',
          expires_at: new Date(Date.now() + 86_400_000),
          tenant: { id: 'tenant-1' },
        },
      ]);

      const result = await service.expireDueExports();
      expect(result.expired).toBe(0);
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });
});
