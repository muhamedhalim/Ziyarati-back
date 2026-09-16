import {
  JourneyParamBuilder,
  buildJourneyDimensionQuery,
  buildJourneyOverallQuery,
  buildReminderRowsQuery,
  type JourneyQueryOptions,
} from './journey-sql';
import { JOURNEY_DIMENSIONS } from './journey.constants';

const baseOpts: JourneyQueryOptions = {
  tenantId: 't-1',
  start: new Date('2026-06-01T00:00:00.000Z'),
  end: new Date('2026-06-30T23:59:59.999Z'),
  now: new Date('2026-07-01T00:00:00.000Z'),
};

/** Every `$n` placeholder used in the SQL text, deduplicated, sorted numerically. */
function placeholderNumbers(sql: string): number[] {
  const found = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

describe('JourneyParamBuilder', () => {
  it('numbers placeholders in push order, starting at $1', () => {
    const p = new JourneyParamBuilder();
    expect(p.push('a')).toBe('$1');
    expect(p.push('b')).toBe('$2');
    expect(p.push('a')).toBe('$3'); // pushing the same value again is a NEW placeholder
    expect(p.params).toEqual(['a', 'b', 'a']);
  });
});

describe('buildJourneyOverallQuery', () => {
  it('every placeholder used in the SQL has a corresponding param, and vice versa', () => {
    const { sql, params } = buildJourneyOverallQuery(baseOpts);
    const numbers = placeholderNumbers(sql);
    expect(numbers).toEqual(
      Array.from({ length: params.length }, (_, i) => i + 1),
    );
  });

  it('omits branch/staff/service filters when not provided', () => {
    const { sql, params } = buildJourneyOverallQuery(baseOpts);
    expect(sql).not.toMatch(/a\."branchId"\s*=/);
    expect(sql).not.toMatch(/a\."staffId"\s*=/);
    expect(sql).not.toMatch(/WHERE single_service_id/);
    // tenantId, start, end, zones, now = 5 params with no optional filter
    expect(params).toHaveLength(5);
  });

  it('adds a branch filter clause and one extra parameter when branchId is set', () => {
    const { sql, params } = buildJourneyOverallQuery({
      ...baseOpts,
      branchId: 'b-1',
    });
    expect(sql).toMatch(/AND a\."branchId" = \$6/);
    expect(params).toHaveLength(6);
    expect(params[5]).toBe('b-1');
  });

  it('adds a staff filter clause and one extra parameter when staffId is set', () => {
    const { sql, params } = buildJourneyOverallQuery({
      ...baseOpts,
      staffId: 's-1',
    });
    expect(sql).toMatch(/AND a\."staffId" = \$6/);
    expect(params).toHaveLength(6);
  });

  it('adds both branch and staff filters, each its own placeholder', () => {
    const { sql, params } = buildJourneyOverallQuery({
      ...baseOpts,
      branchId: 'b-1',
      staffId: 's-1',
    });
    expect(sql).toMatch(/AND a\."branchId" = \$6/);
    expect(sql).toMatch(/AND a\."staffId" = \$7/);
    expect(params).toHaveLength(7);
  });

  it('adds a single-service filter on the v CTE when serviceId is set', () => {
    const { sql, params } = buildJourneyOverallQuery({
      ...baseOpts,
      serviceId: 'svc-1',
    });
    expect(sql).toMatch(/WHERE single_service_id = \$6/);
    expect(params).toHaveLength(6);
    expect(params[5]).toBe('svc-1');
  });

  it('never interpolates the tenantId, branchId or serviceId VALUES into the SQL text', () => {
    const { sql } = buildJourneyOverallQuery({
      ...baseOpts,
      tenantId: 'TENANT-SENTINEL',
      branchId: 'BRANCH-SENTINEL',
      staffId: 'STAFF-SENTINEL',
      serviceId: 'SERVICE-SENTINEL',
    });
    expect(sql).not.toContain('TENANT-SENTINEL');
    expect(sql).not.toContain('BRANCH-SENTINEL');
    expect(sql).not.toContain('STAFF-SENTINEL');
    expect(sql).not.toContain('SERVICE-SENTINEL');
  });

  it('filters out soft-deleted appointments', () => {
    const { sql } = buildJourneyOverallQuery(baseOpts);
    expect(sql).toMatch(/a\.deleted_at IS NULL/);
  });

  it('filters scheduled_notifications to the reminder source_ref prefix only', () => {
    const { sql } = buildJourneyOverallQuery(baseOpts);
    expect(sql).toMatch(/sn\.source_ref LIKE 'appointment-reminder:%'/);
  });

  it('the FINAL select has no GROUP BY (single row) — the svc/sl/rem CTEs legitimately have their own', () => {
    const { sql } = buildJourneyOverallQuery(baseOpts);
    const finalSelect = sql.slice(sql.lastIndexOf('FROM v'));
    expect(finalSelect).not.toMatch(/GROUP BY/i);
  });

  it('casts every named count/duration aggregate as expected', () => {
    const { sql } = buildJourneyOverallQuery(baseOpts);
    expect(sql).toContain(
      "COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled",
    );
    expect(sql).toContain(
      "COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show",
    );
    expect(sql).toContain('COUNT(lead_h)::int AS lead_n');
    expect(sql).toContain('COUNT(consult)::int AS consult_n');
    expect(sql).toContain(
      'percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_start) AS wait_start_p50',
    );
    expect(sql).toContain(
      'percentile_cont(0.5) WITHIN GROUP (ORDER BY (consult - scheduled_min)) AS overrun_p50',
    );
  });
});

describe('buildJourneyDimensionQuery', () => {
  const groupColumnByDimension: Record<string, string> = {
    branch: 'branch_id',
    staff: 'staff_id',
    service: 'single_service_id',
    weekday: 'local_dow',
    hour: 'local_hour',
  };

  it.each(JOURNEY_DIMENSIONS)(
    'groups by the correct column for dimension=%s',
    (dim) => {
      const { sql } = buildJourneyDimensionQuery(baseOpts, dim);
      const col = groupColumnByDimension[dim];
      expect(sql).toMatch(new RegExp(`GROUP BY ${col}\\b`));
      expect(sql).toMatch(new RegExp(`WHERE ${col} IS NOT NULL`));
      expect(sql).toMatch(new RegExp(`SELECT\\s+${col}::text AS dim_key`));
    },
  );

  it('every placeholder used in the SQL has a corresponding param', () => {
    for (const dim of JOURNEY_DIMENSIONS) {
      const { sql, params } = buildJourneyDimensionQuery(baseOpts, dim);
      expect(placeholderNumbers(sql)).toEqual(
        Array.from({ length: params.length }, (_, i) => i + 1),
      );
    }
  });

  it('does not join a name/label table — labels are looked up separately', () => {
    const { sql } = buildJourneyDimensionQuery(baseOpts, 'branch');
    expect(sql).not.toMatch(/JOIN branches b2/);
    expect(sql).not.toMatch(/dim_label/);
  });
});

describe('buildReminderRowsQuery', () => {
  it('every placeholder has a corresponding param', () => {
    const { sql, params } = buildReminderRowsQuery(baseOpts);
    expect(placeholderNumbers(sql)).toEqual(
      Array.from({ length: params.length }, (_, i) => i + 1),
    );
  });

  it('maps FAILED/SEND_UNCERTAIN and a reasoned CANCELLED to outcome=FAILED', () => {
    const { sql } = buildReminderRowsQuery(baseOpts);
    expect(sql).toMatch(/'FAILED', 'SEND_UNCERTAIN'/);
    expect(sql).toMatch(
      /skip_reason IS NOT NULL OR sn\.failure_reason IS NOT NULL/,
    );
  });

  it('parses the lead-minutes suffix from source_ref only when numeric', () => {
    const { sql } = buildReminderRowsQuery(baseOpts);
    expect(sql).toMatch(
      /split_part\(sn\.source_ref, ':', 3\) ~ '\^\[0-9\]\+\$'/,
    );
  });

  it('filters to the reminder source_ref prefix and excludes soft-deleted appointments', () => {
    const { sql } = buildReminderRowsQuery(baseOpts);
    expect(sql).toMatch(/sn\.source_ref LIKE 'appointment-reminder:%'/);
    expect(sql).toMatch(/a\.deleted_at IS NULL/);
  });

  it('adds branch/staff filters with fresh placeholders', () => {
    const { sql, params } = buildReminderRowsQuery({
      ...baseOpts,
      branchId: 'b-1',
      staffId: 's-1',
    });
    expect(sql).toMatch(/AND a\."branchId" = \$5/);
    expect(sql).toMatch(/AND a\."staffId" = \$6/);
    expect(params).toHaveLength(6);
  });
});
