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

  @CreateDateColumn()
  created_at!: Date;
}