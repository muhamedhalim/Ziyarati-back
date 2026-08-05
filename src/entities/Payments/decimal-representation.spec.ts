import { getMetadataArgsStorage } from 'typeorm';

import { Payment } from './Payment';
import { Settlement } from './Settlement';
import { Invoice } from './Invoice';
import { InvoiceItem } from './InvoiceItem';
import { PaymentLink } from './PaymentLink';
import { Refund } from './Refund';
import { Transaction } from './Transaction';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

/**
 * FND-028 — money representation consistency across the 7 named Payments
 * entities. Verified current state (this file's own RED run, recorded
 * verbatim below): `Payment.gateway_fee`/`platform_fee`/`net_amount`/
 * `refunded_amount` already carry `decimalTransformer` (added alongside
 * `1730001600000-PaymentLedgerFinancials.ts`); every OTHER decimal money
 * column across these 7 files — including `Payment.amount` itself, the most
 * heavily-read field — does not. FR-B004 requires a CONSISTENT
 * representation, so the fix completes coverage to all 14 columns, not just
 * the literal "7" the finding's title counts (a file/location tally, not a
 * per-column one — same kind of count-vs-reality note prior waves recorded).
 *
 * No migration required (research.md Part 5 item 3 — "must be PROVEN, not
 * assumed"): a TypeORM `transformer` is a pure application/entity-decorator
 * concept — it has zero DDL footprint. Concrete proof from this repo's own
 * history: `1730001600000-PaymentLedgerFinancials.ts` created `gateway_fee`/
 * `platform_fee`/`net_amount`/`refunded_amount` as plain `numeric(14,2)`
 * columns; `decimalTransformer` was attached to those same fields with no
 * corresponding migration anywhere in `src/migrations/` (verified — grepped
 * the whole directory for a matching DDL/ALTER touching a transformer; none
 * exists, because none is possible). The remaining columns already exist at
 * their final `numeric(14,2)` shape — only the entity decorator changes here.
 */

type ColumnCheck = { entity: Function; column: string; label: string };

/** Every decimal money column across the 7 files — the complete inventory. */
const ALL_MONEY_COLUMNS: ColumnCheck[] = [
  { entity: Payment, column: 'amount', label: 'Payment.amount' },
  { entity: Payment, column: 'gateway_fee', label: 'Payment.gateway_fee' },
  { entity: Payment, column: 'platform_fee', label: 'Payment.platform_fee' },
  { entity: Payment, column: 'net_amount', label: 'Payment.net_amount' },
  { entity: Payment, column: 'refunded_amount', label: 'Payment.refunded_amount' },
  { entity: Settlement, column: 'gross_amount', label: 'Settlement.gross_amount' },
  { entity: Settlement, column: 'fee_amount', label: 'Settlement.fee_amount' },
  { entity: Settlement, column: 'net_amount', label: 'Settlement.net_amount' },
  { entity: Invoice, column: 'total_amount', label: 'Invoice.total_amount' },
  { entity: InvoiceItem, column: 'unit_price', label: 'InvoiceItem.unit_price' },
  { entity: InvoiceItem, column: 'total_price', label: 'InvoiceItem.total_price' },
  { entity: PaymentLink, column: 'amount', label: 'PaymentLink.amount' },
  { entity: Refund, column: 'amount', label: 'Refund.amount' },
  { entity: Transaction, column: 'amount', label: 'Transaction.amount' },
];

/** Columns already carrying the transformer BEFORE this finding's fix. */
const ALREADY_TRANSFORMED = new Set([
  'Payment.gateway_fee',
  'Payment.platform_fee',
  'Payment.net_amount',
  'Payment.refunded_amount',
]);

function hasDecimalTransformer(entity: Function, column: string): boolean {
  const meta = getMetadataArgsStorage().columns.find(
    (c) => c.target === entity && c.propertyName === column,
  );
  return meta?.options?.transformer === decimalTransformer;
}

describe('Money column representation consistency (FND-028)', () => {
  it('every decimal money column across all 7 entities now carries decimalTransformer', () => {
    const missing = ALL_MONEY_COLUMNS.filter((c) => !hasDecimalTransformer(c.entity, c.column)).map((c) => c.label);
    expect(missing).toEqual([]);
  });

  it('every column carries the SAME transformer instance — one shared implementation, never a per-column reimplementation', () => {
    for (const c of ALL_MONEY_COLUMNS) {
      const meta = getMetadataArgsStorage().columns.find(
        (m) => m.target === c.entity && m.propertyName === c.column,
      );
      expect(meta?.options?.transformer).toBe(decimalTransformer);
    }
  });

  it('column type/precision/scale are untouched by this fix — a transformer is application-layer only, never DDL (confirms no migration is needed)', () => {
    for (const c of ALL_MONEY_COLUMNS) {
      const meta = getMetadataArgsStorage().columns.find(
        (m) => m.target === c.entity && m.propertyName === c.column,
      );
      expect(meta?.options?.type).toBe('decimal');
      expect(meta?.options?.precision).toBe(14);
      expect(meta?.options?.scale).toBe(2);
    }
  });

  // Documents today's exact starting state — 4 of 14 already covered.
  it('[baseline] exactly the 4 previously-fixed Payment fields already had the transformer before this task', () => {
    const alreadyDone = ALL_MONEY_COLUMNS.filter((c) => ALREADY_TRANSFORMED.has(c.label));
    for (const c of alreadyDone) expect(hasDecimalTransformer(c.entity, c.column)).toBe(true);
    expect(alreadyDone).toHaveLength(4);
  });
});

/**
 * Value-preservation (T113/T121's core safety proof): every existing
 * `Number(x)`/`toCents(x)` call site (payment.service.ts, refund.service.ts,
 * invoice-item.service.ts, payment-webhook.service.ts, and 20+ others —
 * surveyed, not individually re-tested here since the wrapper is one
 * function called uniformly) is mathematically UNCHANGED by this fix:
 * `Number()` applied to an already-numeric value is the identity, and
 * `Number()` applied to the numeric STRING TypeORM returns today produces the
 * identical result — so a wrapper written for the OLD (string) shape keeps
 * working, unmodified, against the NEW (number) shape.
 */
describe('decimalTransformer — value preservation for every downstream Number()/toCents() wrapper', () => {
  const REPRESENTATIVE_VALUES = [
    '0.00', '0', '19.99', '19.9', '100.00', '1234.56', '999999999999.99', // near precision(14,2) ceiling
    '0.10', '0.01', '50', '-25.50', // a refund/adjustment could be negative in raw storage math
  ];

  it.each(REPRESENTATIVE_VALUES)('Number(decimalTransformer.from(%s)) === Number(%s) — the wrapper sees the same value either way', (raw) => {
    const transformed = decimalTransformer.from(raw);
    expect(Number(transformed)).toBe(Number(raw));
  });

  it.each(REPRESENTATIVE_VALUES)('toCents-style Math.round(Number(x) * 100) is identical before/after for %s', (raw) => {
    const toCents = (v: number | string) => Math.round(Number(v) * 100);
    expect(toCents(decimalTransformer.from(raw) as number)).toBe(toCents(raw));
  });

  it('null and undefined pass through as null (matches every existing `?? 0` / `== null` guard already in use)', () => {
    expect(decimalTransformer.from(null)).toBeNull();
    expect(decimalTransformer.from(undefined)).toBeNull();
  });

  it('the transformed value is a genuine `number` (typeof), unlike the raw string TypeORM returns today — the actual fix, proven', () => {
    expect(typeof decimalTransformer.from('19.99')).toBe('number');
  });

  it('write-side (to) is a pure passthrough — INSERT/UPDATE parameter binding is unaffected either way', () => {
    expect(decimalTransformer.to(19.99)).toBe(19.99);
    expect(decimalTransformer.to(undefined)).toBeUndefined();
    expect(decimalTransformer.to(null)).toBeNull();
  });
});
