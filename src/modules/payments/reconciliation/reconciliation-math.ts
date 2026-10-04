import { PROVIDER_RECONCILIATION } from '../payments.constants';
import type { TapChargeReportRow } from '../providers/tap/tap-report.parser';

/**
 * The comparisons behind the provider reconciliation — pure functions, no I/O, so
 * every verdict is unit-testable on fixtures (Tap's payout report is live-only, so
 * a sandbox cannot produce these inputs).
 *
 * All money is compared in INTEGER CENTS (`round(major × 100)`, the same discipline
 * as the rest of the payments domain); `TOLERANCE_CENTS` absorbs only a rounding
 * difference in the gateway's own figures, never a real discrepancy.
 */

export const toCents = (v: number | string): number =>
  Math.round(Number(v) * 100);

const within = (a: number, b: number, tol: number): boolean =>
  Math.abs(a - b) <= tol;

/** Statuses at which a Tap charge has not finished: nothing can be concluded yet. */
const IN_FLIGHT = new Set(['INITIATED', 'IN_PROGRESS', 'PENDING', 'UNKNOWN']);

// ───────────────────────────── charge vs our record ───────────────────────────── //

/** What we recorded for the charge, reduced to what the comparison needs. */
export interface RecordedCharge {
  amountCents: number;
  currency: string;
  /** TRUE when we booked it as money received (PAID, or since partially / fully refunded). */
  paid: boolean;
}

export type ChargeVerdict =
  | { verdict: 'ok' }
  /** Tap has not finished the charge (or it is too young to judge): say nothing. */
  | { verdict: 'in_flight' }
  | { verdict: 'too_recent' }
  | {
      verdict: 'amount_mismatch';
      reportAmountCents: number;
      recordAmountCents: number;
      reportCurrency: string;
      recordCurrency: string;
    }
  /** Captured at Tap, but we do not have it as paid. */
  | { verdict: 'unpaid_but_captured' }
  /** We have it as paid, but Tap reports a terminal NON-capture (declined, voided, …). */
  | { verdict: 'paid_but_not_captured'; reportStatus: string };

export function checkCharge(
  row: TapChargeReportRow,
  record: RecordedCharge,
  now: number,
  graceMs: number = PROVIDER_RECONCILIATION.SETTLE_GRACE_MS,
): ChargeVerdict {
  const tooRecent = row.chargeDate
    ? now - row.chargeDate.getTime() < graceMs
    : false;

  if (row.status === 'CAPTURED') {
    // Amount and currency are facts, not timing: a mismatch is reported at once.
    if (
      row.currency.toUpperCase() !== record.currency.toUpperCase() ||
      toCents(row.amount) !== record.amountCents
    ) {
      return {
        verdict: 'amount_mismatch',
        reportAmountCents: toCents(row.amount),
        recordAmountCents: record.amountCents,
        reportCurrency: row.currency.toUpperCase(),
        recordCurrency: record.currency.toUpperCase(),
      };
    }
    if (!record.paid) {
      // A webhook / the return page / the 10-minute sweep may simply not have landed yet.
      return tooRecent
        ? { verdict: 'too_recent' }
        : { verdict: 'unpaid_but_captured' };
    }
    return { verdict: 'ok' };
  }

  if (IN_FLIGHT.has(row.status)) return { verdict: 'in_flight' };

  // A terminal non-capture (DECLINED, FAILED, VOID, ABANDONED, TIMEDOUT, …).
  if (record.paid) {
    return tooRecent
      ? { verdict: 'too_recent' }
      : { verdict: 'paid_but_not_captured', reportStatus: row.status };
  }
  return { verdict: 'ok' };
}

// ───────────────────────────────────── fees ───────────────────────────────────── //

export type FeeEvaluation =
  /** The report carries no fee for this charge (blank / unpaid-out yet): try again next run. */
  | { kind: 'incomplete' }
  /** First time we learn the fee: record it. `netInconsistent` = Tap's own `net_amount` disagrees with amount − fee − VAT. */
  | {
      kind: 'apply';
      gatewayFee: number;
      netAmount: number;
      netInconsistent: boolean;
      reportedNet?: number;
    }
  /** Already recorded, and the report agrees. */
  | { kind: 'unchanged' }
  /** Already recorded, and the report now says something else. NEVER overwritten. */
  | { kind: 'changed'; recordedFee: number; reportedFee: number };

export function evaluateFee(
  row: TapChargeReportRow,
  payment: {
    amount: number;
    gateway_fee: number;
    platform_fee: number;
    fees_reconciled: boolean;
  },
  tolerance: number = PROVIDER_RECONCILIATION.TOLERANCE_CENTS,
): FeeEvaluation {
  if (row.fee === undefined) return { kind: 'incomplete' };
  const reportedFeeC = toCents(row.fee) + toCents(row.feeVat ?? 0);

  if (payment.fees_reconciled) {
    return within(toCents(payment.gateway_fee), reportedFeeC, tolerance)
      ? { kind: 'unchanged' }
      : {
          kind: 'changed',
          recordedFee: toCents(payment.gateway_fee) / 100,
          reportedFee: reportedFeeC / 100,
        };
  }

  // The domain's own formula: net = gross − gateway fee − platform fee.
  const netC =
    toCents(payment.amount) - reportedFeeC - toCents(payment.platform_fee);
  // Tap's own `net_amount` is net of ITS fee only; compare it on that basis.
  const tapNetC = toCents(payment.amount) - reportedFeeC;
  const netInconsistent =
    row.netAmount !== undefined &&
    !within(toCents(row.netAmount), tapNetC, tolerance);
  return {
    kind: 'apply',
    gatewayFee: reportedFeeC / 100,
    netAmount: netC / 100,
    netInconsistent,
    reportedNet: row.netAmount,
  };
}

// ──────────────────────────────────── payouts ─────────────────────────────────── //

export interface PayoutEvaluation {
  matches: boolean;
  payoutCents: number;
  /** Σ net of the charges the payout paid out. */
  chargesNetCents: number;
  /** What we recorded as refunded against those charges (context; may be netted in the payout). */
  refundsCents: number;
  /** payout − charges net, in cents (positive: Tap paid out more than the charges explain). */
  differenceCents: number;
}

/**
 * Does a payout equal what its charges explain?
 *
 * Tap does not document how refunds enter a payout, so BOTH readings are accepted:
 * `Σ net` and `Σ net − refunds recorded against those charges`. A payout matching
 * neither is flagged for a human; one matching either is not.
 */
export function evaluatePayout(
  payoutAmount: number,
  chargesNetCents: number,
  refundsCents: number,
  tolerance: number = PROVIDER_RECONCILIATION.TOLERANCE_CENTS,
): PayoutEvaluation {
  const payoutCents = toCents(payoutAmount);
  const matches =
    within(payoutCents, chargesNetCents, tolerance) ||
    within(payoutCents, chargesNetCents - refundsCents, tolerance);
  return {
    matches,
    payoutCents,
    chargesNetCents,
    refundsCents,
    differenceCents: payoutCents - chargesNetCents,
  };
}

/** Map a Tap payout status to the domain's `PayoutStatus`; anything unknown stays PENDING (never PAID by guess). */
export function mapPayoutStatus(
  status: string | undefined,
): 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' {
  switch (
    String(status ?? '')
      .trim()
      .toUpperCase()
  ) {
    case 'PAID_OUT':
    case 'PAID':
      return 'PAID';
    case 'INITIATED':
    case 'IN_PROGRESS':
    case 'PROCESSING':
      return 'PROCESSING';
    case 'FAILED':
    case 'REJECTED':
    case 'CANCELLED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

// ──────────────────────────────── duplicate captures ──────────────────────────────── //

export interface DuplicateGroup {
  /** The shared business reference (our appointment id, else our payment / invoice id). */
  key: string;
  merchantId?: string;
  /** Every CAPTURED charge sharing it, oldest first. */
  chargeIds: string[];
}

/**
 * Charges that share one business reference. This is only a CANDIDATE list: a
 * booking that was paid, fully refunded and paid again legitimately has two
 * captures too, so the caller drops those with its own records before raising anything.
 */
export function groupCapturedByReference(
  rows: TapChargeReportRow[],
): DuplicateGroup[] {
  const groups = new Map<string, TapChargeReportRow[]>();
  for (const row of rows) {
    if (row.status !== 'CAPTURED') continue;
    const key = row.referenceOrder ?? row.referenceTransaction;
    if (!key) continue;
    const bucket = `${row.merchantId ?? ''}|${key}`;
    groups.set(bucket, [...(groups.get(bucket) ?? []), row]);
  }
  const out: DuplicateGroup[] = [];
  for (const members of groups.values()) {
    const distinct = [...new Map(members.map((r) => [r.chargeId, r])).values()];
    if (distinct.length < 2) continue;
    distinct.sort(
      (a, b) =>
        (a.chargeDate?.getTime() ?? 0) - (b.chargeDate?.getTime() ?? 0) ||
        a.chargeId.localeCompare(b.chargeId),
    );
    out.push({
      key: distinct[0].referenceOrder ?? distinct[0].referenceTransaction!,
      merchantId: distinct[0].merchantId,
      chargeIds: distinct.map((r) => r.chargeId),
    });
  }
  return out;
}
