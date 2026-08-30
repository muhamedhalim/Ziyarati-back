import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Appointment } from './Appointment';
import { CalendarSlot } from './CalendarSlot';
import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { AppointmentActionOrigin } from '../enums';

@Entity('appointment_reschedules')
@Index(['appointment'])
export class AppointmentReschedule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => CalendarSlot, {
    nullable: true,
  })
  old_slot?: CalendarSlot;

  @ManyToOne(() => CalendarSlot, {
    nullable: true,
  })
  new_slot?: CalendarSlot;

  @Column({
    type: 'text',
    nullable: true,
  })
  reason?: string;

  @ManyToOne(() => User, {
    nullable: true,
  })
  rescheduled_by?: User;

  /**
   * Spec 014 (Clinic Platform Completion) — T019/T020 (FR-R012). Who
   * initiated this reschedule. Column added by
   * `1730063500000-AppointmentActionOrigin`, default `'STAFF'` so every
   * historical row is correctly labelled without a backfill pass.
   */
  @Column({ type: 'varchar', length: 16, default: AppointmentActionOrigin.STAFF })
  origin!: AppointmentActionOrigin;

  @CreateDateColumn()
  created_at!: Date;
}