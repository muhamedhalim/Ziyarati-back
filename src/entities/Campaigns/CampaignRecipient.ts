import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Unique,
  Index,
} from 'typeorm';

import { Campaign } from './Campaign';
import { CampaignRun } from './CampaignRun';
import { Customer } from '../CRM/Customer';
import { RecipientProcessing, RecipientDelivery, FailureClass } from '../enums';

/**
 * One customer's slot in a single campaign run.
 *
 * The old single `status` column is split into two orthogonal axes:
 *  - {@link RecipientProcessing} — owned by the WORKER ("did we hand it off?")
 *  - {@link RecipientDelivery}   — owned by provider WEBHOOKS ("what did the
 *    carrier say?"). The two never write the same column, so the worker and a
 *    late-arriving delivery callback can't clobber each other.
 *
 * `provider_ref` is UNIQUE: it is the hard idempotency floor — a duplicate send
 * that produces the same provider message id is rejected by the database.
 */
@Entity('campaign_recipients')
@Unique('uq_recipient_run_customer', ['run', 'customer'])
@Index('ix_recipient_run_processing', ['run', 'processing'])
@Index('ix_recipient_campaign_customer', ['campaign', 'customer'])
export class CampaignRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => CampaignRun, { onDelete: 'CASCADE' })
  run!: CampaignRun;

  /** Denormalized campaign link (kept for cross-run history / convenience). */
  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  campaign!: Campaign;

  @ManyToOne(() => Customer)
  customer!: Customer;

  @Column({
    type: 'enum',
    enum: RecipientProcessing,
    default: RecipientProcessing.PENDING,
  })
  processing!: RecipientProcessing;

  @Column({
    type: 'enum',
    enum: RecipientDelivery,
    default: RecipientDelivery.NONE,
  })
  delivery!: RecipientDelivery;

  /** Provider message id — UNIQUE so a duplicate dispatch cannot double-send. */
  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  provider_ref?: string | null;

  @Column({ type: 'enum', enum: FailureClass, nullable: true })
  failure_class?: FailureClass | null;

  @Column({ type: 'text', nullable: true })
  failure_reason?: string | null;

  @Column('int', { default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  dispatched_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at?: Date | null;

  /**
   * When this recipient's dead-letter entry was CONFIRMED written to
   * `campaigns.dlq` (FND-020) — null means either not dead-lettered, or
   * dead-lettered but the DLQ write itself hasn't been confirmed yet (the
   * enqueue failed, or a recovery sweep hasn't run since). Distinguishing
   * these is exactly what makes the recovery sweep possible.
   */
  @Column({ type: 'timestamptz', nullable: true })
  dlq_recorded_at?: Date | null;

  @CreateDateColumn()
  created_at!: Date;
}
