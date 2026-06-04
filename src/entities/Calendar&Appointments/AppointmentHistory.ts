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

@Entity('appointment_history')
export class AppointmentHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'uuid',
    nullable: true,
  })
  changed_by?: string;

  @Column({
    type: 'enum',
    enum: AppointmentStatus,
    nullable: true,
  })
  old_status?: AppointmentStatus;

  @Column({
    type: 'enum',
    enum: AppointmentStatus,
  })
  new_status!: AppointmentStatus;

  @Column({
    type: 'text',
    nullable: true,
  })
  note?: string;

  @CreateDateColumn()
  created_at!: Date;
}