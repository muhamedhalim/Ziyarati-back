import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

@Entity('notification_logs')
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @Column({ length: 100, nullable: true })
  template_id?: string;

  @Column({ length: 20, nullable: true })
  recipient_type?: string;

  @Column({ type: 'uuid', nullable: true })
  recipient_id?: string;

  @Column({ length: 20, nullable: true })
  channel?: string;

  @Column({ length: 20, nullable: true })
  status?: string;

  /** Provider message id for this attempt (correlates webhook delivery events). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  provider_ref?: string;

  @Column({ type: 'text', nullable: true })
  error_message?: string;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at?: Date;

  /**
   * When the QUEUED -> SENDING claim was taken (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.5). NULL for any row predating this
   * column, or one never claimed at all. Lets the claim tell "in-flight"
   * apart from "the claiming worker crashed and this is stuck" — see
   * `WhatsappExecutionService.claimQueuedLog`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  claimed_at?: Date;

  /**
   * Caller-supplied business key (e.g. `workflow-action:{runId}:{actionIndex}`)
   * — partial-unique (see migration `WorkflowActionSourceRef1730016000000`) so
   * the DATABASE rejects a second row for the same business operation, giving
   * callers with no content-hash floor of their own (unlike email_logs) a real
   * idempotency guarantee. NULL for rows from callers with no business key.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  source_ref?: string | null;

  @CreateDateColumn()
  created_at!: Date;
}