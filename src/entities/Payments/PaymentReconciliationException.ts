import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Something the daily provider reconciliation (or a live check) found that a HUMAN
 * must look at: a duplicate capture, an amount / status / fee / settlement
 * mismatch, a charge the gateway holds that we do not, …
 *
 * The system NEVER resolves one of these by moving money. It records what it saw,
 * and an operator decides (refund the duplicate, correct the record, or ignore it).
 *
 * One row per (kind, provider_object_id): a re-run of the same sweep finds the
 * SAME row again (`occurrences`, `last_seen_at`) rather than piling up duplicates.
 * A row an operator RESOLVED / IGNORED is reopened only if the discrepancy itself
 * changed (`details_hash`), so a settled question is not asked every night.
 *
 * Platform-wide data (an exception can span tenants and platform revenue): it is
 * only ever exposed through super-admin routes.
 */
@Entity('payment_reconciliation_exceptions')
@Index('UQ_recon_exception_kind_object', ['kind', 'provider_object_id'], {
  unique: true,
})
@Index('IX_recon_exception_status_seen', ['status', 'last_seen_at'])
export class PaymentReconciliationException {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** RECONCILIATION_KIND value (payments.constants). Free-form varchar so a new kind never needs an ALTER. */
  @Column({ type: 'varchar', length: 40 })
  kind!: string;

  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  /** The gateway object the discrepancy is about: a charge, refund, payout or merchant id. */
  @Column({ type: 'varchar', length: 96 })
  provider_object_id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenant_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  payment_id?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  merchant_id?: string | null;

  /** Facts for the operator: amounts, statuses, ids. Never a credential or card data. */
  @Column({ type: 'jsonb', nullable: true })
  details?: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  details_hash?: string | null;

  /** EXCEPTION_STATUS value: OPEN | RESOLVED | IGNORED. */
  @Column({ type: 'varchar', length: 16, default: 'OPEN' })
  status!: string;

  @Column({ type: 'int', default: 1 })
  occurrences!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  first_seen_at!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  last_seen_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at?: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolved_by?: string | null;

  @Column({ type: 'text', nullable: true })
  resolution_note?: string | null;
}
