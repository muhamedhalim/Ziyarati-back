import { createMockQueryBuilder } from '../../../../test/utils/mock-factories';
import { ReportQueryBuilder } from './report-query.builder';

describe('ReportQueryBuilder.instantRange (T022, spec 014)', () => {
  it('applies an inclusive BETWEEN on the given timestamptz column', () => {
    const qb = createMockQueryBuilder();
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-31T23:59:59Z');

    ReportQueryBuilder.instantRange(qb as any, 'p', 'paid_at', from, to);

    expect(qb.andWhere).toHaveBeenCalledWith(
      'p.paid_at BETWEEN :instantFrom AND :instantTo',
      { instantFrom: from, instantTo: to },
    );
  });

  it('applies the branch filter only when branchId is supplied', () => {
    const qb = createMockQueryBuilder();
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-31T23:59:59Z');

    ReportQueryBuilder.instantRange(qb as any, 'p', 'paid_at', from, to, 'branch-1');

    expect(qb.andWhere).toHaveBeenCalledWith('p.branch = :instantBranchId', {
      instantBranchId: 'branch-1',
    });
  });

  it('omits the branch filter when branchId is not supplied', () => {
    const qb = createMockQueryBuilder();
    ReportQueryBuilder.instantRange(
      qb as any,
      'p',
      'paid_at',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-31T23:59:59Z'),
    );
    expect(qb.andWhere).toHaveBeenCalledTimes(1); // only the date range
  });
});
