import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Appointment } from './Appointment';
import { Tenant } from '../SaaS-Core/Tenant';
import { AppointmentStatus } from '../enums';

@Entity('appointment_status_logs')
export class AppointmentStatusLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'enum',
    enum: AppointmentStatus,
  })
  status!: AppointmentStatus;

  @Column({
    nullable: true,
  })
  triggered_by?: string;

  @CreateDateColumn()
  created_at!: Date;
}