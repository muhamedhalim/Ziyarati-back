import {
  checkCharge,
  evaluateFee,
  evaluatePayout,
  groupCapturedByReference,
  mapPayoutStatus,
  toCents,
} from './reconciliation-math';
import type { TapChargeReportRow } from '../providers/tap/tap-report.parser';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const HOURS = 60 * 60_000;

const row = (over: Partial<TapChargeReportRow> = {}): TapChargeReportRow => ({
  chargeId: 'chg_1',
  status: 'CAPTURED',
  currency: 'SAR',
  amount: 250,
  chargeDate: new Date(NOW - 5 * HOURS),
  ...over,
});
const rec = (over: Record<string, unknown> = {}) => ({
  amountCents: 25000,
  currency: 'SAR',
  paid: true,
  ...over,
});

describe('toCents', () => {
  it.each([
    [250, 25000],
    [0.1 + 0.2, 30],
    [49.99, 4999],
    ['12.345', 1235],
  ])('%s → %s', (v, c) => expect(toCents(v)).toBe(c));
});

describe('checkCharge', () => {
  it('a CAPTURED charge we hold as paid, same amount and currency → ok', () => {
    expect(checkCharge(row(), rec(), NOW)).toEqual({ verdict: 'ok' });
  });

  it('currency is compared case-insensitively', () => {
    expect(checkCharge(row({ currency: 'sar' }), rec(), NOW)).toEqual({
      verdict: 'ok',
    });
  });

  describe('amount / currency — a fact, reported immediately, even for a young charge', () => {
    it('different amount', () => {
      expect(
        checkCharge(
          row({ amount: 1, chargeDate: new Date(NOW - 1000) }),
          rec(),
          NOW,
        ),
      ).toEqual({
        verdict: 'amount_mismatch',
        reportAmountCents: 100,
        recordAmountCents: 25000,
        reportCurrency: 'SAR',
        recordCurrency: 'SAR',
      });
    });
    it('different currency', () => {
      expect(checkCharge(row({ currency: 'USD' }), rec(), NOW)).toMatchObject({
        verdict: 'amount_mismatch',
        reportCurrency: 'USD',
      });
    });
    it("a one-cent difference is a mismatch here (the tolerance is for the gateway's own fee figures, not for what was charged)", () => {
      expect(checkCharge(row({ amount: 250.01 }), rec(), NOW).verdict).toBe(
        'amount_mismatch',
      );
    });
  });

  describe('captured at Tap but not paid here', () => {
    it('is flagged once the charge is old enough that our own paths must have landed', () => {
      expect(checkCharge(row(), rec({ paid: false }), NOW)).toEqual({
        verdict: 'unpaid_but_captured',
      });
    });
    it('is NOT judged while the charge is younger than the grace window (the webhook / sweep may be in flight)', () => {
      expect(
        checkCharge(
          row({ chargeDate: new Date(NOW - 30 * 60_000) }),
          rec({ paid: false }),
          NOW,
        ),
      ).toEqual({ verdict: 'too_recent' });
    });
    it('a report with no charge date is treated as old (it cannot be excused as recent)', () => {
      expect(
        checkCharge(row({ chargeDate: undefined }), rec({ paid: false }), NOW)
          .verdict,
      ).toBe('unpaid_but_captured');
    });
  });

  describe('paid here but not captured at Tap', () => {
    it.each([
      'DECLINED',
      'FAILED',
      'VOID',
      'ABANDONED',
      'TIMEDOUT',
      'CANCELLED',
      'RESTRICTED',
    ])('%s while we have it as paid → flagged', (status) => {
      expect(checkCharge(row({ status }), rec(), NOW)).toEqual({
        verdict: 'paid_but_not_captured',
        reportStatus: status,
      });
    });
    it('…unless the charge is too recent to judge', () => {
      expect(
        checkCharge(
          row({ status: 'VOID', chargeDate: new Date(NOW - 60_000) }),
          rec(),
          NOW,
        ).verdict,
      ).toBe('too_recent');
    });
    it('a failed charge we also hold as unpaid agrees → ok', () => {
      expect(
        checkCharge(row({ status: 'DECLINED' }), rec({ paid: false }), NOW),
      ).toEqual({
        verdict: 'ok',
      });
    });
  });

  it.each(['INITIATED', 'IN_PROGRESS', 'UNKNOWN'])(
    '%s: Tap has not finished — nothing to conclude',
    (status) => {
      expect(checkCharge(row({ status }), rec(), NOW).verdict).toBe(
        'in_flight',
      );
      expect(
        checkCharge(row({ status }), rec({ paid: false }), NOW).verdict,
      ).toBe('in_flight');
    },
  );
});

describe('evaluateFee', () => {
  const pay = (over: Record<string, unknown> = {}) => ({
    amount: 250,
    gateway_fee: 0,
    platform_fee: 0,
    fees_reconciled: false,
    ...over,
  });

  it('a report with no fee cell is incomplete (try again tomorrow), never "zero fee"', () => {
    expect(evaluateFee(row({ fee: undefined }), pay())).toEqual({
      kind: 'incomplete',
    });
  });

  it('first time: records fee + VAT as the gateway fee and the domain net', () => {
    expect(
      evaluateFee(row({ fee: 3.75, feeVat: 0.56, netAmount: 245.69 }), pay()),
    ).toEqual({
      kind: 'apply',
      gatewayFee: 4.31,
      netAmount: 245.69,
      netInconsistent: false,
      reportedNet: 245.69,
    });
  });

  it('VAT is optional (some merchants report only `fee`)', () => {
    expect(evaluateFee(row({ fee: 5 }), pay())).toMatchObject({
      kind: 'apply',
      gatewayFee: 5,
      netAmount: 245,
      netInconsistent: false,
    });
  });

  it("subtracts a platform fee too, in the domain net (but compares Tap's net on Tap's own basis)", () => {
    expect(
      evaluateFee(row({ fee: 5, netAmount: 245 }), pay({ platform_fee: 2 })),
    ).toMatchObject({ kind: 'apply', netAmount: 243, netInconsistent: false });
  });

  it("flags Tap's own net_amount when it disagrees with amount − fee − VAT, but still records the fee", () => {
    expect(
      evaluateFee(row({ fee: 3.75, feeVat: 0.56, netAmount: 200 }), pay()),
    ).toMatchObject({
      kind: 'apply',
      gatewayFee: 4.31,
      netInconsistent: true,
      reportedNet: 200,
    });
  });

  it("a one-cent rounding difference in Tap's net is tolerated", () => {
    expect(
      evaluateFee(row({ fee: 3.75, feeVat: 0.56, netAmount: 245.7 }), pay()),
    ).toMatchObject({
      netInconsistent: false,
    });
  });

  describe('already reconciled', () => {
    it('the same fee → unchanged', () => {
      expect(
        evaluateFee(
          row({ fee: 3.75, feeVat: 0.56 }),
          pay({ gateway_fee: 4.31, fees_reconciled: true }),
        ),
      ).toEqual({ kind: 'unchanged' });
    });
    it('a different fee → changed, and the recorded value is reported (never silently overwritten)', () => {
      expect(
        evaluateFee(
          row({ fee: 6, feeVat: 0.9 }),
          pay({ gateway_fee: 4.31, fees_reconciled: true }),
        ),
      ).toEqual({ kind: 'changed', recordedFee: 4.31, reportedFee: 6.9 });
    });
    it('a one-cent difference is tolerated', () => {
      expect(
        evaluateFee(
          row({ fee: 3.75, feeVat: 0.57 }),
          pay({ gateway_fee: 4.31, fees_reconciled: true }),
        ),
      ).toEqual({ kind: 'unchanged' });
    });
  });
});

describe('evaluatePayout (plan test 19 — settlement mismatch)', () => {
  it('a payout equal to the net of its charges matches', () => {
    expect(evaluatePayout(490.0, 49000, 0)).toMatchObject({
      matches: true,
      differenceCents: 0,
    });
  });

  it('a payout short of its charges is a mismatch, with the difference in cents', () => {
    expect(evaluatePayout(480, 49000, 0)).toEqual({
      matches: false,
      payoutCents: 48000,
      chargesNetCents: 49000,
      refundsCents: 0,
      differenceCents: -1000,
    });
  });

  it('a payout LARGER than its charges explain is a mismatch too', () => {
    expect(evaluatePayout(500, 49000, 0)).toMatchObject({
      matches: false,
      differenceCents: 1000,
    });
  });

  it('accepts the reading where refunds on those charges were netted out of the payout', () => {
    // charges net 490.00, 100.00 refunded against them, payout 390.00
    expect(evaluatePayout(390, 49000, 10000)).toMatchObject({ matches: true });
    // …and the reading where they were not
    expect(evaluatePayout(490, 49000, 10000)).toMatchObject({ matches: true });
    // …but not an amount that explains neither
    expect(evaluatePayout(440, 49000, 10000).matches).toBe(false);
  });

  it('absorbs a one-cent rounding difference, nothing more', () => {
    expect(evaluatePayout(490.01, 49000, 0).matches).toBe(true);
    expect(evaluatePayout(490.02, 49000, 0).matches).toBe(false);
  });
});

describe('mapPayoutStatus', () => {
  it.each([
    ['PAID_OUT', 'PAID'],
    ['paid_out', 'PAID'],
    ['INITIATED', 'PROCESSING'],
    ['IN_PROGRESS', 'PROCESSING'],
    ['PENDING', 'PENDING'],
    ['FAILED', 'FAILED'],
    ['REJECTED', 'FAILED'],
  ])('%s → %s', (s, d) => expect(mapPayoutStatus(s)).toBe(d));

  it.each([undefined, '', 'SOMETHING_NEW', 'SETTLED'])(
    '%j is PENDING — never PAID by guess',
    (s) => {
      expect(mapPayoutStatus(s as string | undefined)).toBe('PENDING');
    },
  );
});

describe('groupCapturedByReference', () => {
  it('two captures sharing a reference.order form a candidate group, oldest first', () => {
    const groups = groupCapturedByReference([
      row({
        chargeId: 'chg_B',
        referenceOrder: 'appt-1',
        chargeDate: new Date(NOW - 1 * HOURS),
      }),
      row({
        chargeId: 'chg_A',
        referenceOrder: 'appt-1',
        chargeDate: new Date(NOW - 3 * HOURS),
      }),
      row({ chargeId: 'chg_C', referenceOrder: 'appt-2' }),
    ]);
    expect(groups).toEqual([
      { key: 'appt-1', merchantId: undefined, chargeIds: ['chg_A', 'chg_B'] },
    ]);
  });

  it('falls back to reference.transaction when there is no order', () => {
    const groups = groupCapturedByReference([
      row({ chargeId: 'chg_1', referenceTransaction: 'inv-1' }),
      row({ chargeId: 'chg_2', referenceTransaction: 'inv-1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('inv-1');
  });

  it('only CAPTURED charges count (a declined first attempt is not a duplicate)', () => {
    expect(
      groupCapturedByReference([
        row({
          chargeId: 'chg_1',
          status: 'DECLINED',
          referenceOrder: 'appt-1',
        }),
        row({ chargeId: 'chg_2', referenceOrder: 'appt-1' }),
      ]),
    ).toEqual([]);
  });

  it('the same reference under different merchants is not a group', () => {
    expect(
      groupCapturedByReference([
        row({ chargeId: 'chg_1', referenceOrder: 'appt-1', merchantId: 'm1' }),
        row({ chargeId: 'chg_2', referenceOrder: 'appt-1', merchantId: 'm2' }),
      ]),
    ).toEqual([]);
  });

  it('the same charge listed twice is one charge', () => {
    expect(
      groupCapturedByReference([
        row({ chargeId: 'chg_1', referenceOrder: 'appt-1' }),
        row({ chargeId: 'chg_1', referenceOrder: 'appt-1' }),
      ]),
    ).toEqual([]);
  });

  it('a charge with no business reference is never grouped', () => {
    expect(
      groupCapturedByReference([
        row({ chargeId: 'chg_1' }),
        row({ chargeId: 'chg_2' }),
      ]),
    ).toEqual([]);
  });
});
