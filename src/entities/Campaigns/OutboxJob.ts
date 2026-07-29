import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { OutboxStatus } from '../enums';

/**
 * Transactional outbox row.
 *
 * A domain state change (e.g. launching a campaign run, dispatching a webhook
 * event, accepting an inbound integration event) and the intent to emit a queue
 * job are written in the SAME database transaction — one row here. A separate
 * relay (OutboxRelayService, in the worker) polls PENDING rows and publishes
 * them to BullMQ, then marks them PUBLISHED. This guarantees no job is lost if
 * the process dies between the DB commit and the enqueue, and the deterministic
 * `dedupe_key` (used as the BullMQ jobId) makes the at-least-once relay safe
 * against duplicates.
 *
 * Despite the folder (`entities/Campaigns`), this table is domain-agnostic and
 * used across the platform (campaigns, webhook delivery, integration
 * import/sync/inbound, workflow runs — see docs/CACHING_QUEUES_AUDIT.md §0.5
 * item 4). Left in place rather than moved, to avoid an unrelated file-move
 * diff on top of the actual schema change.
 */
@Entity('outbox_jobs')
@Index('ix_outbox_status_created', ['status', 'created_at'])
export class OutboxJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  queue!: string;

  @Column({ type: 'varchar', length: 96 })
  job_name!: string;

  /** Deterministic BullMQ jobId for idempotent publish. */
  @Column({ type: 'varchar', length: 255, unique: true })
  dedupe_key!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * Optional per-job BullMQ options (attempts/backoff/delay) to pass through
   * to `QueueService.publish` at relay time — e.g. webhook delivery's
   * non-default attempts/backoff, or a notification's computed `delay`.
   * `null`/absent means the target queue's `defaultJobOptions` apply.
   */
  @Column({ type: 'jsonb', nullable: true })
  opts?: Record<string, unknown> | null;

  @Column({
    type: 'enum',
    enum: OutboxStatus,
    default: OutboxStatus.PENDING,
  })
  status!: OutboxStatus;

  @Column('int', { default: 0 })
  publish_attempts!: number;

  @Column({ type: 'text', nullable: true })
  last_error?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  published_at?: Date | null;

  /** Set when claimed (PENDING → PUBLISHING). Used to detect a claim stuck by a crashed relay. */
  @Column({ type: 'timestamptz', nullable: true })
  claimed_at?: Date | null;

  @CreateDateColumn()
  created_at!: Date;
}
