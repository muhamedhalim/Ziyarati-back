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
}