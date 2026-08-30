import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  REPORT_EXPORT_AUDIT_ACTION,
  ReportExportAuditService,
} from './report-export-audit.service';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

/**
 * T185 (spec 014, US13, FR-X012). Export is a data-egress action: every
 * request AND completion must be recorded, with the report key and
 * filters — NEVER the exported row data.
 */
describe('ReportExportAuditService (T185)', () => {
  let service: ReportExportAuditService;
  let auditLogs: MockRepository;

  beforeEach(async () => {
    auditLogs = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReportExportAuditService,
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
      ],
    }).compile();
    service = moduleRef.get(ReportExportAuditService);
  });

  afterEach(() => jest.clearAllMocks());

  it('records the request with the report key, filters and actor — stage "requested"', async () => {
    await service.recordRequested(
      'tenant-1',
      'job-1',
      'staff-performance',
      { branchId: 'branch-9' },
      'user-1',
    );

    expect(auditLogs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: { id: 'tenant-1' },
        user: { id: 'user-1' },
        action: REPORT_EXPORT_AUDIT_ACTION.EXPORTED,
        entity_type: 'ExportJob',
        entity_id: 'job-1',
        new_values: {
          stage: 'requested',
          report: 'staff-performance',
          filters: { branchId: 'branch-9' },
        },
      }),
    );
  });

  it('records completion with the row count — never the exported rows themselves', async () => {
    await service.recordCompleted(
      'tenant-1',
      'job-1',
      'staff-performance',
      { branchId: 'branch-9' },
      42,
      'user-1',
    );

    const call = auditLogs.save.mock.calls[0][0];
    expect(call.new_values).toEqual({
      stage: 'completed',
      report: 'staff-performance',
      filters: { branchId: 'branch-9' },
      rowCount: 42,
    });
    // The audit payload never carries a `rows`/`data` key.
    expect(Object.keys(call.new_values)).not.toContain('rows');
    expect(Object.keys(call.new_values)).not.toContain('data');
  });

  it('is best-effort — a write failure never throws to the caller', async () => {
    auditLogs.save.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.recordRequested('tenant-1', 'job-1', 'staff-performance', {}),
    ).resolves.toBeUndefined();
  });
});
