import { SegmentQueryBuilder } from './segment-query.builder';
import { SegmentField, SegmentOperator } from './segment.constants';
import { AppError } from '../../common/errors';

const TENANT = 'tenant-1';

describe('SegmentQueryBuilder (T119 — FR-S002, R8)', () => {
  let builder: SegmentQueryBuilder;

  beforeEach(() => {
    builder = new SegmentQueryBuilder();
  });

  it('always scopes to the tenant and excludes soft-deleted customers, even with no rules', () => {
    const { whereSql, values } = builder.build(TENANT, [], 'ALL');
    expect(whereSql).toBe('c."tenantId" = $1 AND c.deleted_at IS NULL');
    expect(values).toEqual([TENANT]);
  });

  it('MARKETING_CONSENT — IS_TRUE / IS_FALSE bind a boolean, never a string fragment', () => {
    const yes = builder.build(
      TENANT,
      [{ field: SegmentField.MARKETING_CONSENT, op: SegmentOperator.IS_TRUE }],
      'ALL',
    );
    expect(yes.whereSql).toContain('c.marketing_opt_in = $2');
    expect(yes.values[1]).toBe(true);

    const no = builder.build(
      TENANT,
      [{ field: SegmentField.MARKETING_CONSENT, op: SegmentOperator.IS_FALSE }],
      'ALL',
    );
    expect(no.values[1]).toBe(false);
  });

  it('MESSAGING_OPTED_OUT — IS_TRUE checks opted_out_at IS NOT NULL', () => {
    const { whereSql } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.MESSAGING_OPTED_OUT,
          op: SegmentOperator.IS_TRUE,
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('c.opted_out_at IS NOT NULL');
  });

  it('CUSTOMER_ACTIVE — binds a boolean against is_active', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [{ field: SegmentField.CUSTOMER_ACTIVE, op: SegmentOperator.IS_FALSE }],
      'ALL',
    );
    expect(whereSql).toContain('c.is_active = $2');
    expect(values[1]).toBe(false);
  });

  it('CUSTOMER_CREATED_AT — AFTER/BEFORE bind the date value as a parameter', () => {
    const after = builder.build(
      TENANT,
      [
        {
          field: SegmentField.CUSTOMER_CREATED_AT,
          op: SegmentOperator.AFTER,
          value: '2026-01-01',
        },
      ],
      'ALL',
    );
    expect(after.whereSql).toContain('c.created_at > $2');
    expect(after.values[1]).toBe('2026-01-01');
  });

  it('BIRTH_DATE_IN_PERIOD — WITHIN_DAYS compiles a wrap-around day-of-year window', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.BIRTH_DATE_IN_PERIOD,
          op: SegmentOperator.WITHIN_DAYS,
          value: 14,
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('c.date_of_birth IS NOT NULL');
    expect(whereSql).toContain("DATE_PART('doy'");
    expect(values[1]).toBe(14);
  });

  it('CUSTOMER_TAG — CONTAINS compiles an EXISTS over customer_tag_relations', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.CUSTOMER_TAG,
          op: SegmentOperator.CONTAINS,
          value: 'tag-1',
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('EXISTS');
    expect(whereSql).toContain('customer_tag_relations');
    expect(values[1]).toBe('tag-1');
  });

  it('LAST_APPOINTMENT_AT — AFTER/BEFORE compiles a MAX(start_at) HAVING clause, tenant-scoped', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.LAST_APPOINTMENT_AT,
          op: SegmentOperator.AFTER,
          value: '2026-01-01',
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('MAX(a.start_at) >');
    expect(whereSql).toContain('a."tenantId" = $1');
    expect(values[1]).toBe('2026-01-01');
  });

  it('APPOINTMENT_COUNT — GREATER_THAN/LESS_THAN/EQUALS compile a scalar subquery comparison', () => {
    const gt = builder.build(
      TENANT,
      [
        {
          field: SegmentField.APPOINTMENT_COUNT,
          op: SegmentOperator.GREATER_THAN,
          value: 3,
        },
      ],
      'ALL',
    );
    expect(gt.whereSql).toContain('COUNT(*)');
    expect(gt.whereSql).toContain('> $2');
    expect(gt.values[1]).toBe(3);
  });

  it('APPOINTMENT_STATUS — EQUALS compiles an EXISTS filtering a.status', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.APPOINTMENT_STATUS,
          op: SegmentOperator.EQUALS,
          value: 'COMPLETED',
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('a.status = $2');
    expect(values[1]).toBe('COMPLETED');
  });

  it('SERVICE_BOOKED — CONTAINS compiles an EXISTS joining appointment_services', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.SERVICE_BOOKED,
          op: SegmentOperator.CONTAINS,
          value: 'service-1',
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('appointment_services');
    expect(whereSql).toContain('aps."serviceId" = $2');
    expect(values[1]).toBe('service-1');
  });

  it('BRANCH_ATTENDED — CONTAINS compiles an EXISTS filtering a.branchId', () => {
    const { whereSql, values } = builder.build(
      TENANT,
      [
        {
          field: SegmentField.BRANCH_ATTENDED,
          op: SegmentOperator.CONTAINS,
          value: 'branch-1',
        },
      ],
      'ALL',
    );
    expect(whereSql).toContain('a."branchId" = $2');
    expect(values[1]).toBe('branch-1');
  });

  it('ALL joins multiple rules with AND', () => {
    const { whereSql } = builder.build(
      TENANT,
      [
        { field: SegmentField.CUSTOMER_ACTIVE, op: SegmentOperator.IS_TRUE },
        { field: SegmentField.MARKETING_CONSENT, op: SegmentOperator.IS_TRUE },
      ],
      'ALL',
    );
    expect(whereSql).toMatch(/is_active = \$2 AND c\.marketing_opt_in = \$3/);
  });

  it('ANY joins multiple rules with OR', () => {
    const { whereSql } = builder.build(
      TENANT,
      [
        { field: SegmentField.CUSTOMER_ACTIVE, op: SegmentOperator.IS_TRUE },
        { field: SegmentField.MARKETING_CONSENT, op: SegmentOperator.IS_TRUE },
      ],
      'ANY',
    );
    expect(whereSql).toMatch(/is_active = \$2 OR c\.marketing_opt_in = \$3/);
  });

  describe('injection defence (R8) — an unknown field never reaches the query as a fragment', () => {
    it('rejects a field outside the closed enum with a 400, before any SQL is built', () => {
      expect(() =>
        builder.build(
          TENANT,
          [
            {
              field: 'id"; DROP TABLE customers; --' as SegmentField,
              op: SegmentOperator.EQUALS,
            },
          ],
          'ALL',
        ),
      ).toThrow(AppError);
    });

    it('rejects an operator the field does not support', () => {
      expect(() =>
        builder.build(
          TENANT,
          [
            {
              field: SegmentField.CUSTOMER_ACTIVE,
              op: SegmentOperator.CONTAINS,
            },
          ],
          'ALL',
        ),
      ).toThrow(AppError);
    });
  });
});
