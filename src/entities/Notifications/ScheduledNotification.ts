import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { NotificationTemplate } from './NotificationTemplate';
import { Appointment } from '../Calendar&Appointments/Appointment';

@Entity('scheduled_notifications')
@Index(['scheduled_at', 'status'])
export class ScheduledNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => NotificationTemplate, {
    nullable: true,
  })
  template?: NotificationTemplate;

  @ManyToOne(() => Appointment, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  appointment?: Appointment;

  @Column({ length: 20, nullable: true })
  recipient_type?: string;

  @Column({ type: 'uuid', nullable: true })
  recipient_id?: string;

  @Column({ type: 'timestamptz' })
  scheduled_at!: Date;

  /** Worker-owned send lifecycle (SCHEDULED→PROCESSING→SENT/FAILED/CANCELLED). */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'SCHEDULED',
  })
  status!: string;

  /** Webhook-owned delivery lifecycle (NONE/ACCEPTED/DELIVERED/READ/FAILED). */
  @Column({ type: 'varchar', length: 20, default: 'NONE' })
  delivery_status!: string;

  /** Provider message id (e.g. WhatsApp wamid). UNIQUE → idempotency floor. */
  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  provider_ref?: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  failure_reason?: string | null;

  /**
   * At-most-once send guard. Set true atomically right before the provider call;
   * a stale-claim reclaim that finds it already true will NOT re-send (prevents
   * the crash-after-accept duplicate). Reset on retry / transient failure.
   */
  @Column({ type: 'boolean', default: false })
  send_attempted!: boolean;

  /** Per-notification template variable values (merged over template defaults). */
  @Column({ type: 'jsonb', nullable: true })
  variables?: Record<string, unknown> | null;

  /** When the current PROCESSING claim was taken — drives stale-claim recovery. */
  @Column({ type: 'timestamptz', nullable: true })
  processing_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at?: Date | null;

  /**
   * Caller-supplied business key (e.g. `workflow-action:{runId}:{actionIndex}`)
   * — partial-unique (see migration `WorkflowActionSourceRef1730016000000`),
   * so a caller that retries the SAME logical schedule request (not a new one)
   * gets the database's own guarantee that only one row is ever created for
   * it, instead of creating a second independently-dispatched row. NULL for
   * rows from callers with no business key (e.g. direct HTTP scheduling).
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  source_ref?: string | null;

  /**
   * Spec 014 (Clinic Platform Completion) — T015 (FR-G012, FR-M015). Which
   * channel actually carried a terminal (SENT or FAILED) outcome — may
   * differ from the template's configured channel when a WhatsApp send
   * fell back to email (T014). NULL until a terminal outcome is reached.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  channel?: string | null;

  /** Why no channel was used at all — set only alongside a terminal FAILED
   *  with no send attempted (e.g. opted out, no reachable recipient). A
   *  bounded, non-secret label — NEVER a raw provider error (see T015). */
  @Column({ type: 'varchar', length: 40, nullable: true })
  skip_reason?: string | null;

  @CreateDateColumn()
  created_at!: Date;
}