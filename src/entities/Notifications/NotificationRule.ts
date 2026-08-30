import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { NotificationTemplate } from './NotificationTemplate';

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

  @CreateDateColumn()
  created_at!: Date;
}