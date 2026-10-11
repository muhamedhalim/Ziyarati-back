import {
  EMPTY_COUNTS,
  PeriodCounts,
  buildAlerts,
  buildFailureReasons,
  compareCount,
  compareRate,
  computeRates,
  normalizeFailureCode,
  percent,
  resolveWindows,
  safeTimeZone,
  toCounts,
} from './whatsapp-notification-analytics.calc';

const counts = (over: Partial<PeriodCounts>): PeriodCounts => ({
  ...EMPTY_COUNTS,
  ...over,
});

describe('percent', () => {
  it('is null — never 0, 100 or NaN — when the denominator is 0', () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(5, 0)).toBeNull();
  });

  it('rounds to one decimal and stays inside 0..100', () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(7, 5)).toBe(100);
  });

  it('rejects non-finite input instead of propagating NaN', () => {
    expect(percent(Number.NaN, 10)).toBeNull();
    expect(percent(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('computeRates', () => {
  it('has no rate for an empty period', () => {
    const { rates, denominators } = computeRates(EMPTY_COUNTS);
    expect(rates).toEqual({
      successRate: null,
      failureRate: null,
      deliveryRate: null,
      readRate: null,
    });
    expect(denominators).toEqual({
      resolved: 0,
      whatsappSent: 0,
      delivered: 0,
    });
  });

  it('does not count pending, cancelled or scheduled rows as successes or failures', () => {
    const { rates, denominators } = computeRates(
      counts({ total: 100, pending: 60, cancelled: 20, sent: 15, failed: 5 }),
    );
    // 20 resolved, not 100: pending/cancelled are not outcomes yet.
    expect(denominators.resolved).toBe(20);
    expect(rates.successRate).toBe(75);
    expect(rates.failureRate).toBe(25);
  });

  it('keeps SEND_UNCERTAIN in the denominator so success is not inflated', () => {
    const { rates } = computeRates(
      counts({ sent: 8, failed: 1, uncertain: 1 }),
    );
    expect(rates.successRate).toBe(80);
  });

  it('derives delivery from WhatsApp-carried sends only (email fallback excluded)', () => {
    const { rates, denominators } = computeRates(
      counts({
        sent: 10,
        whatsappSent: 8,
        emailFallback: 2,
        delivered: 6,
        read: 3,
      }),
    );
    expect(denominators.whatsappSent).toBe(8);
    expect(rates.deliveryRate).toBe(75); // 6 / 8, not 6 / 10
    expect(rates.readRate).toBe(50); // 3 / 6 delivered
  });

  it('has no read rate when nothing was delivered', () => {
    const { rates } = computeRates(
      counts({ sent: 4, whatsappSent: 4, delivered: 0, read: 0 }),
    );
    expect(rates.deliveryRate).toBe(0);
    expect(rates.readRate).toBeNull();
  });
});

describe('compareCount', () => {
  it('reports absolute and percentage change', () => {
    expect(compareCount(150, 100)).toEqual({
      current: 150,
      previous: 100,
      absolute: 50,
      percent: 50,
      state: 'changed',
    });
    expect(compareCount(50, 100)).toMatchObject({
      absolute: -50,
      percent: -50,
    });
  });

  it('does not invent +100% / +Infinity from a zero baseline', () => {
    expect(compareCount(7, 0)).toMatchObject({
      percent: null,
      state: 'new',
      absolute: 7,
    });
  });

  it('says "none" when nothing happened in either period', () => {
    expect(compareCount(0, 0)).toMatchObject({
      percent: null,
      state: 'none',
      absolute: 0,
    });
  });
});

describe('compareRate', () => {
  it('is the percentage-point difference', () => {
    expect(compareRate(80, 72.5)).toEqual({
      current: 80,
      previous: 72.5,
      points: 7.5,
    });
  });

  it('has no difference unless both periods have a rate', () => {
    expect(compareRate(80, null).points).toBeNull();
    expect(compareRate(null, 80).points).toBeNull();
  });
});

describe('resolveWindows', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');

  it('builds an equal-length, adjacent previous window', () => {
    const { current, previous } = resolveWindows('30d', now);
    expect(current.to).toEqual(now);
    expect(previous.to.getTime()).toBe(current.from.getTime());
    expect(current.to.getTime() - current.from.getTime()).toBe(
      previous.to.getTime() - previous.from.getTime(),
    );
    expect(current.to.getTime() - current.from.getTime()).toBe(
      30 * 24 * 3600 * 1000,
    );
  });

  it.each([
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s spans %i days', (range, days) => {
    const { current } = resolveWindows(range, now);
    expect((current.to.getTime() - current.from.getTime()) / 86_400_000).toBe(
      days,
    );
  });
});

describe('toCounts', () => {
  it('coerces pg string counts and defaults the rest to 0', () => {
    expect(toCounts({ total: '12', sent: '9', failed: 3 })).toMatchObject({
      total: 12,
      sent: 9,
      failed: 3,
      delivered: 0,
    });
  });

  it('never yields NaN or negatives from bad input', () => {
    const c = toCounts({ total: 'abc', sent: -4, failed: null });
    expect(c.total).toBe(0);
    expect(c.sent).toBe(0);
    expect(c.failed).toBe(0);
  });

  it('is all-zero for a missing row', () => {
    expect(toCounts(undefined)).toEqual(EMPTY_COUNTS);
  });
});

describe('failure reasons', () => {
  it('maps unknown codes to OTHER so raw text can never leak through', () => {
    expect(normalizeFailureCode('OPTED_OUT')).toBe('OPTED_OUT');
    expect(normalizeFailureCode('recipient has +966500000000 opted out')).toBe(
      'OTHER',
    );
    expect(normalizeFailureCode('UNKNOWN')).toBe('OTHER');
    expect(normalizeFailureCode(null)).toBe('OTHER');
  });

  it('merges, ranks and shares over the unsuccessful total', () => {
    const rows = buildFailureReasons([
      { code: 'OPTED_OUT', count: '6' },
      { code: 'UNKNOWN', count: '1' },
      { code: 'OTHER', count: '1' },
      { code: 'PROVIDER_ERROR', count: '2' },
    ]);
    expect(rows[0]).toEqual({ code: 'OPTED_OUT', count: 6, sharePercent: 60 });
    expect(rows.find((r) => r.code === 'OTHER')).toMatchObject({
      count: 2,
      sharePercent: 20,
    });
  });

  it('is empty when nothing failed', () => {
    expect(buildFailureReasons([])).toEqual([]);
  });
});

describe('buildAlerts', () => {
  it('raises nothing for an empty period', () => {
    expect(buildAlerts(EMPTY_COUNTS, [])).toEqual([]);
  });

  it('does not alert on a high failure RATE from a tiny sample', () => {
    const alerts = buildAlerts(counts({ sent: 1, failed: 4 }), []);
    expect(alerts.find((a) => a.code === 'HIGH_FAILURE_RATE')).toBeUndefined();
  });

  it('alerts on a high failure rate with a sufficient sample', () => {
    const alerts = buildAlerts(counts({ sent: 70, failed: 30 }), []);
    expect(alerts).toContainEqual({
      code: 'HIGH_FAILURE_RATE',
      severity: 'critical',
      value: 30,
    });
  });

  it('alerts on quota exhaustion and unresolved send outcomes', () => {
    const alerts = buildAlerts(counts({ uncertain: 2 }), [
      { code: 'QUOTA_EXHAUSTED', count: 3, sharePercent: 100 },
    ]);
    expect(alerts.map((a) => a.code).sort()).toEqual([
      'QUOTA_EXHAUSTED',
      'SEND_UNCERTAIN',
    ]);
  });

  it('flags missing delivery confirmations only for mature sends with enough volume', () => {
    expect(
      buildAlerts(
        counts({ matureWhatsappSent: 10, matureUnconfirmed: 10 }),
        [],
      ),
    ).toEqual([]);
    expect(
      buildAlerts(
        counts({ matureWhatsappSent: 40, matureUnconfirmed: 30 }),
        [],
      ),
    ).toContainEqual({
      code: 'NO_DELIVERY_CONFIRMATION',
      severity: 'warning',
      value: 75,
    });
  });
});

describe('safeTimeZone', () => {
  it('keeps a valid IANA zone and falls back to UTC otherwise', () => {
    expect(safeTimeZone('Asia/Riyadh')).toBe('Asia/Riyadh');
    expect(safeTimeZone('Not/AZone')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
    expect(safeTimeZone("UTC'; DROP TABLE x;--")).toBe('UTC');
  });
});
