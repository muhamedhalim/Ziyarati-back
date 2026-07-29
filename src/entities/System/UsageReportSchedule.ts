import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * A super-admin scheduled usage report. Delivery is transport-agnostic (email
 * now, webhook now, more later) and the report body is assembled from the
 * existing PlatformUsageService (no report data is computed here). Not
 * tenant-scoped — these are platform-owner reports.
 */
@Entity('usage_report_schedules')
@Index(['is_active'])
export class UsageReportSchedule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  /** DAILY | WEEKLY | MONTHLY | CUSTOM. */
  @Column({ length: 16 })
  frequency!: string;

  /** Cron pattern when frequency = CUSTOM (informational; the tick evaluates due-ness). */
  @Column({ nullable: true })
  cron?: string;

  /** EMAIL | WEBHOOK. */
  @Column({ length: 16 })
  delivery!: string;

  /** Email address or webhook URL. */
  @Column()
  target!: string;

  /** JSON | CSV | EXCEL. */
  @Column({ length: 8, default: 'JSON' })
  format!: string;

  /** Report sections to include (null = all). */
  @Column({ type: 'jsonb', nullable: true })
  sections?: string[];

  @Column({ default: true })
  is_active!: boolean;

  @Column({ type: 'uuid', nullable: true })
  created_by?: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_run_at?: Date;

  @Column({ type: 'text', nullable: true })
  last_status?: string;

  /**
   * Per-recipient `{ [target]: 'SENT' }` progress WITHIN the current due
   * cycle (EMAIL delivery only — `target` may be a comma-separated list).
   * Written incrementally, after each recipient send succeeds, so a hard
   * process crash mid-loop leaves an accurate durable record of who has
   * already been sent to; cleared to `{}` once every recipient succeeds.
   * See `UsageReportService.deliver`.
   */
  @Column({ type: 'jsonb', nullable: true })
  last_run_recipient_status?: Record<string, string> | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
