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
 * A domain state change (e.g. launching a campaign run) and the intent to emit a
 * queue job are written in the SAME database transaction — one row here. A
 * separate relay (OutboxRelayService, in the worker) polls PENDING rows and
 * publishes them to BullMQ, then marks them PUBLISHED. This guarantees no job is
 * lost if the process dies between the DB commit and the enqueue, and the
 * deterministic `dedupe_key` (used as the BullMQ jobId) makes the at-least-once
 * relay safe against duplicates.
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

  @CreateDateColumn()
  created_at!: Date;
}
