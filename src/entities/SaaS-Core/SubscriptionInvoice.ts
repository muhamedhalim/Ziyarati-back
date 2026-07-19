import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { InvoiceStatus } from '../enums';

@Entity('subscription_invoices')
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