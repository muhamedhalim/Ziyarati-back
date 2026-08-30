import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { InvoiceStatus } from '../enums';

// FND-032/M-04: at most one OPEN invoice per subscription at a time (a
// closed/paid invoice does NOT block a later one — the predicate scopes to
// status='OPEN' only). See migration SubscriptionInvoiceOpenUniqueness for
// the full rationale (no period column exists on this table — data-model.md
// D-4 — so this is deliberately not "tenant + period").
@Entity('subscription_invoices')
@Index('UQ_sub_invoice_open_per_subscription', ['subscription_id'], {
  unique: true,
  where: `"status" = 'OPEN'`,
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
   * T083 (spec 014, US5) — dedup key for a Moyasar webhook confirming this
   * invoice's charge. `Transaction.payment` is a required FK, so the
   * one-time-payment ledger's own dedup mechanism cannot be reused here
   * (subscription charges are a deliberately separate financial stream —
   * see `subscription-billing.module.ts`); `UQ_sub_invoice_webhook_event`
   * enforces the same "at most once" guarantee scoped to this table.
   */
  @Column({ type: 'varchar', nullable: true })
  webhook_event_id?: string | null;
}
