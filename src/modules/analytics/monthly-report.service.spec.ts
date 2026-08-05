import { MonthlyReportService } from './monthly-report.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AppError, ErrorCode } from '../../common/errors';

function buildInsertChain() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['insert', 'values', 'orUpdate']) qb[method] = jest.fn(() => qb);
  qb.execute = jest.fn().mockResolvedValue(undefined);
  return qb;
}

function buildSelectChain(result: unknown = null) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'leftJoinAndSelect', 'where', 'andWhere']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getOne = jest.fn().mockResolvedValue(result);
  return qb;
}

/**
 * Baseline coverage for previously-untested EXISTING behavior (no prior spec
 * file existed for this service) — locked down as a regression net for
 * FND-014's "the manual path still works" requirement, not new RED/GREEN
 * behavior: every assertion here already passes against the pre-fix code.
 */
describe('MonthlyReportService', () => {
  let service: MonthlyReportService;
  let reports: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let aggregation: {
    assertBranch: jest.Mock;
    listActiveBranchIds: jest.Mock;
    computeMonthlyTotals: jest.Mock;
    computeMonthlyExtras: jest.Mock;
  };

  beforeEach(() => {
    reports = {
      createQueryBuilder: jest.fn(() => buildInsertChain()),
      findOne: jest.fn().mockResolvedValue({
        id: 'r1',
        period_month: '2026-07',
        total_appointments: 3,
        total_revenue: 150,
      }),
    };
    aggregation = {
      assertBranch: jest.fn().mockResolvedValue({ id: 'b1' }),
      listActiveBranchIds: jest.fn().mockResolvedValue(['b1', 'b2']),
      computeMonthlyTotals: jest
        .fn()
        .mockResolvedValue({ total_appointments: 3, total_revenue: 150 }),
      computeMonthlyExtras: jest
        .fn()
        .mockResolvedValue({ avg_rating: 4.5, top_services: [] }),
    };
    service = new MonthlyReportService(
      reports as any,
      aggregation as unknown as AnalyticsAggregationService,
    );
  });

  it('generates one report for an explicit branchId (upsert on tenant+branch+period_month)', async () => {
    const report = await service.generate('t1', { branchId: 'b1', month: '2026-07' });
    expect(aggregation.assertBranch).toHaveBeenCalledWith('t1', 'b1');
    expect(aggregation.computeMonthlyTotals).toHaveBeenCalledWith('t1', 'b1', '2026-07');
    expect(reports.findOne).toHaveBeenCalledWith({
      where: { tenant: { id: 't1' }, branch: { id: 'b1' }, period_month: '2026-07' },
      relations: { branch: true },
    });
    expect(report).toMatchObject({ id: 'r1' });
  });

  it('with no branchId, fans out across every active branch (batch)', async () => {
    const result = (await service.generate('t1', { month: '2026-07' })) as {
      generated: unknown[];
      failed: unknown[];
    };
    expect(aggregation.listActiveBranchIds).toHaveBeenCalledWith('t1');
    expect(aggregation.computeMonthlyTotals).toHaveBeenCalledWith('t1', 'b1', '2026-07');
    expect(aggregation.computeMonthlyTotals).toHaveBeenCalledWith('t1', 'b2', '2026-07');
    expect(result.generated).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it('with no branchId and no active branches, refuses rather than silently no-op', async () => {
    aggregation.listActiveBranchIds.mockResolvedValue([]);
    await expect(service.generate('t1', { month: '2026-07' })).rejects.toMatchObject({
      code: ErrorCode.UNPROCESSABLE_ENTITY,
    });
  });

  it('isolates a per-branch failure rather than aborting the whole batch', async () => {
    aggregation.computeMonthlyTotals
      .mockResolvedValueOnce({ total_appointments: 3, total_revenue: 150 })
      .mockRejectedValueOnce(new Error('boom'));
    const result = (await service.generate('t1', { month: '2026-07' })) as {
      generated: unknown[];
      failed: { branchId: string; error: string }[];
    };
    expect(result.generated).toHaveLength(1);
    expect(result.failed).toEqual([{ branchId: 'b2', error: 'boom' }]);
  });

  it('get() 404s when the report is not found in this tenant (cross-tenant safe)', async () => {
    reports.createQueryBuilder.mockReturnValue(buildSelectChain(null));
    await expect(service.get('t1', 'missing-id')).rejects.toBeInstanceOf(AppError);
  });

  it('get() returns the report when found in this tenant', async () => {
    reports.createQueryBuilder.mockReturnValue(
      buildSelectChain({ id: 'r1', period_month: '2026-07' }),
    );
    const report = await service.get('t1', 'r1');
    expect(report).toMatchObject({ id: 'r1' });
  });
});
