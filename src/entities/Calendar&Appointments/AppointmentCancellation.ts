import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Appointment } from './Appointment';
import { Tenant } from '../SaaS Core/Tenant';
import { User } from '../Auth&RBAC/User';

@Entity('appointment_cancellations')
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
  })
  refund_amount?: number;

  @CreateDateColumn()
  created_at!: Date;
}