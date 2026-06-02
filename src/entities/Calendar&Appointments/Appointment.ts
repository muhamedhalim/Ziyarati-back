import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  JoinColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { Customer } from '../CRM/Customer';
import { StaffProfile } from '../Staff/StaffProfile';
import { User } from '../Auth&RBAC/User';
import { CalendarSlot } from './CalendarSlot';

import { AppointmentService } from './AppointmentService';
import { AppointmentHistory } from './AppointmentHistory';
import { AppointmentStatusLog } from './AppointmentStatusLog';
import { AppointmentNote } from './AppointmentNote';
import { AppointmentSource, AppointmentStatus } from '../enums';

@Entity('appointments')
@Index(['tenant', 'branch', 'start_at'])
@Index(['staff', 'start_at'])
@Index(['customer', 'start_at'])
export class Appointment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch)
  branch!: Branch;

  @ManyToOne(() => Customer)
  customer!: Customer;

  @ManyToOne(() => StaffProfile)
  staff!: StaffProfile;

  @ManyToOne(() => CalendarSlot, {
    nullable: true,
  })
  @JoinColumn({ name: 'slot_id' })
  slot?: CalendarSlot;

  @Column({
    type: 'timestamptz',
  })
  start_at!: Date;

  @Column({
    type: 'timestamptz',
  })
  end_at!: Date;

  @Column({
    type: 'enum',
    enum: AppointmentStatus,
    default: AppointmentStatus.PENDING_PAYMENT,
  })
  status!: AppointmentStatus;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  total_amount?: number;

  @Column({
    default: 'USD',
    length: 3,
  })
  currency!: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  notes?: string;

  @Column({
    type: 'enum',
    enum: AppointmentSource,
    default: AppointmentSource.WHATSAPP_BOT,
  })
  source!: AppointmentSource;

  @ManyToOne(() => User, {
    nullable: true,
  })
  booked_by?: User;

  @OneToMany(
    () => AppointmentService,
    (service) => service.appointment,
  )
  services!: AppointmentService[];

  @OneToMany(
    () => AppointmentHistory,
    (history) => history.appointment,
  )
  history!: AppointmentHistory[];

  @OneToMany(
    () => AppointmentStatusLog,
    (log) => log.appointment,
  )
  statusLogs!: AppointmentStatusLog[];

  @OneToMany(
    () => AppointmentNote,
    (note) => note.appointment,
  )
  appointmentNotes!: AppointmentNote[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}