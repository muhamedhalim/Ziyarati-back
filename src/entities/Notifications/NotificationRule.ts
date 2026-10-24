import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { NotificationTemplate } from './NotificationTemplate';

/**
 * `rule_key` is partial-unique per tenant (migration NotificationRuleLibrary): a
 * clinic holds at most one row per ready-made rule. NULL for hand-made rules.
 */
@Index('UQ_notification_rules_tenant_rule_key', ['tenant', 'rule_key'], {
  unique: true,
  where: '"rule_key" IS NOT NULL',
})
@Entity('notification_rules')
export class NotificationRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => NotificationTemplate, {
    nullable: true,
  })
  template?: NotificationTemplate;

  @Column({ length: 100 })
  trigger_event!: string;

  @Column({ default: 0 })
  delay_minutes!: number;

  @Column({ default: true })
  is_active!: boolean;

  /**
   * Spec 014 (Clinic Platform Completion) — S3. `AFTER_EVENT` (the
   * pre-existing, only behaviour): `scheduled_at` = trigger time +
   * `delay_minutes`. `BEFORE_APPOINTMENT_START`: `scheduled_at` = the
   * appointment's own start − `delay_minutes`, computed in the appointment's
   * captured `booked_timezone`. Defaults to `AFTER_EVENT` so every existing
   * rule's scheduling behaviour is byte-identical after this column lands.
   */
  @Column({ type: 'varchar', length: 24, default: 'AFTER_EVENT' })
  anchor!: 'AFTER_EVENT' | 'BEFORE_APPOINTMENT_START';

  /** Which ready-made rule this is (`confirmation`, `reminder_24h`, …); NULL for a hand-made rule. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  rule_key?: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  name?: string | null;

  /**
   * Typed rule settings (send window, inactivity days, …) — validated by
   * `rule-library/rule-conditions.ts`; never an expression, never executed.
   */
  @Column({ type: 'jsonb', nullable: true })
  conditions?: Record<string, unknown> | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  /** When this rule last scheduled a message. */
  @Column({ type: 'timestamptz', nullable: true })
  last_run_at?: Date | null;

  /** Last scrubbed scheduling failure — a bounded label, never message content. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  last_error?: string | null;
}
