import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { InvoiceStatus } from '../enums';

// FND-032/M-04: at most one OPEN invoice per subscription at a time (a
// closed/paid invoice does NOT block a later one — the predicate scopes to
// status='OPEN' only). See migration SubscriptionInvoiceOpenUniqueness for
// the full rationale (no period column exists on this table — data-model.md
// D-4 — so this is deliberately not "tenant + period").
@Entity('subscription_invoices')
// One provider charge settles at most one invoice (migration SubscriptionBillingIntegrityIndexes).
@Index('UQ_sub_invoice_provider_reference', ['provider_reference'], {
  unique: true,
  where: `"provider_reference" IS NOT NULL AND "status" <> 'VOID'`,
})
@Index('UQ_sub_invoice_open_per_subscription', ['subscription_id'], {
  unique: true,
  where: `"status" = 'OPEN'`,
})
// Sales Staff Management: revenue / conversion attribution filters PAID
// invoices by tenant and `paid_at` window. Partial, so it stays small and
// costs nothing on the OPEN/VOID/RETRY write path.
@Index('IX_subscription_invoices_tenant_paid', ['tenant_id', 'paid_at'], {
  where: `"status" = 'PAID'`,
})
export class SubscriptionInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenant_id!: string;

  @Column()
  subscription_id!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({
    type: 'enum',
    enum: InvoiceStatus,
    default: InvoiceStatus.OPEN,
  })
  status!: InvoiceStatus;

  @Column({ type: 'timestamptz', nullable: true })
  issued_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at?: Date;

  /**
   * Opaque provider charge reference (e.g. gateway payment id) persisted for
   * support/reconciliation. NEVER card data — only the provider's reference.
   */
  @Column({ nullable: true })
  provider_reference?: string;

  /** Last provider decline reason (domain-safe text, no raw provider errors). */
  @Column({ type: 'text', nullable: true })
  failure_reason?: string | null;

  /**
   * Charge-claim timestamp: set atomically when a payInvoice attempt claims
   * this invoice, cleared on decline. A second concurrent attempt cannot claim
   * an invoice whose claim is fresh — DB-level double-charge protection.
   */
  @Column({ type: 'timestamptz', nullable: true })
  charge_started_at?: Date | null;

  // ── T079 (spec 014, US5) — the billing PERIOD this invoice covers ──────── //

  /** The subscription window this invoice bills for — together with
   *  `subscription_id`, the unit `UQ_sub_invoice_period` enforces "at most
   *  one non-VOID invoice per period" at the database level. */
  @Column({ type: 'timestamptz' })
  period_start!: Date;

  @Column({ type: 'timestamptz' })
  period_end!: Date;

  /** The PLATFORM's billing currency at issue time (`SettingKey
   *  .DEFAULT_CURRENCY`), snapshotted — never the clinic's own
   *  `tenant_settings.currency` (FR-B002a). */
  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  /** How many charge attempts this invoice has had — drives the +1/+3/+5
   *  day retry schedule, capped at grace expiry. */
  @Column({ type: 'int', default: 0 })
  retry_count!: number;

  /** When the next automatic retry is due. NULL once the invoice is
   *  settled, VOID, or retries are exhausted. */
  @Column({ type: 'timestamptz', nullable: true })
  next_retry_at?: Date | null;

  /**
   * Coarse decline classification — distinguishes "we cannot charge yet"
   * (`TOKENIZATION_UNAVAILABLE`, the production stand-in until saved-card
   * tokenization exists) from an ordinary provider decline. NOT a DB enum:
   * additive-only, like `APPOINTMENT_AUDIT_ACTION` — a new class must never
   * repurpose an existing value.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  failure_class?: string | null;

  /**
   * T083 (spec 014, US5) — dedup key for a gateway webhook confirming this
   * invoice's charge. `Transaction.payment` is a required FK, so the
   * one-time-payment ledger's own dedup mechanism cannot be reused here
   * (subscription charges are a deliberately separate financial stream —
   * see `subscription-billing.module.ts`); `UQ_sub_invoice_webhook_event`
   * enforces the same "at most once" guarantee scoped to this table.
   */
  @Column({ type: 'varchar', nullable: true })
  webhook_event_id?: string | null;

  // ── Tap migration (Phase 3) ─────────────────────────────────────────────── //

  /**
   * What this invoice buys (`SubscriptionInvoiceKind`). NULL = legacy invoice
   * issued before the column existed: settling one only marks it PAID.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  kind?: string | null;

  /**
   * The plan this invoice pays for. Settling it makes THIS the subscription's
   * plan (INITIAL/UPGRADE/REACTIVATION/RENEWAL alike), so the outcome is driven
   * by what was billed rather than by whatever the subscription says later.
   */
  @Column({ type: 'uuid', nullable: true })
  target_plan_id?: string | null;

  /** Which gateway settled (or is settling) it: `tap`, `stub`, … NULL = legacy. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  provider?: string | null;

  /** The saved card this invoice was charged to (merchant-initiated), if any. */
  @Column({ type: 'uuid', nullable: true })
  payment_method_id?: string | null;

  /**
   * Hosted-checkout bookkeeping. `checkout_charge_id` is the most recent hosted
   * charge, `checkout_started_at` when it was opened, `checkout_attempts` the
   * counter that makes each NEW checkout's idempotency key unique
   * (`subinv:{id}:co:{n}`). A fresh checkout blocks a merchant-initiated charge
   * of the same invoice, so a clinic paying by hand cannot be double-captured by
   * the renewal job.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  checkout_charge_id?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  checkout_started_at?: Date | null;

  @Column({ type: 'int', default: 0 })
  checkout_attempts!: number;

  // ── Tap migration (Phase 5) — the platform's own refund of this invoice ──── //

  /** The gateway's refund id (`re_…`) for the CURRENT refund attempt. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  refund_reference?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  refund_requested_at?: Date | null;

  /** Set when the refund COMPLETED (the invoice is then REFUNDED). */
  @Column({ type: 'timestamptz', nullable: true })
  refunded_at?: Date | null;

  /** Refund attempts so far — part of the gateway idempotency key, so a retry after a decline is a NEW refund. */
  @Column({ type: 'int', default: 0 })
  refund_attempts!: number;

  @Column({ type: 'text', nullable: true })
  refund_reason?: string | null;
}
