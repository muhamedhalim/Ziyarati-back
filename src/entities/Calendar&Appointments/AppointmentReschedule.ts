import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Appointment } from './Appointment';
import { CalendarSlot } from './CalendarSlot';
import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';

@Entity('appointment_reschedules')
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

  @CreateDateColumn()
  created_at!: Date;
}