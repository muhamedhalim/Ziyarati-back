import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Appointment } from './Appointment';
import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { AppointmentActionOrigin } from '../enums';

@Entity('appointment_cancellations')
@Index(['appointment'])
export class AppointmentCancellation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'text',
    nullable: true,
  })
  reason?: string;

  @ManyToOne(() => User, {
    nullable: true,
  })
  cancelled_by?: User;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  refund_amount?: number;

  /**
   * Spec 014 (Clinic Platform Completion) — T019/T020 (FR-C010). Who
   * initiated this cancellation. Column added by
   * `1730063500000-AppointmentActionOrigin`, default `'STAFF'` so every
   * historical row is correctly labelled without a backfill pass.
   */
  @Column({ type: 'varchar', length: 16, default: AppointmentActionOrigin.STAFF })
  origin!: AppointmentActionOrigin;

  @CreateDateColumn()
  created_at!: Date;
}