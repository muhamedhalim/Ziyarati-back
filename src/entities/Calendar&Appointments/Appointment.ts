import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { Customer } from '../CRM/Customer';
import { StaffProfile } from '../Staff/StaffProfile';
import { User } from '../Auth&RBAC/User';
import { CalendarSlot } from './CalendarSlot';

import { AppointmentService } from './AppointmentService';
import { AppointmentHistory } from './AppointmentHistory';
import { AppointmentStatusLog } from './AppointmentStatusLog';
import { AppointmentNote } from './AppointmentNote';
import { AppointmentSource, AppointmentStatus, AppointmentPaymentStatus } from '../enums';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

@Entity('appointments')
@Index(['tenant', 'branch', 'start_at'])
@Index(['staff', 'start_at'])
@Index(['customer', 'start_at'])
@Index(['branch', 'status', 'start_at']) // status-filtered calendar queries
@Check('appointments_end_after_start', '"end_at" > "start_at"')
@Check('appointments_total_nonneg', '"total_amount" IS NULL OR "total_amount" >= 0')
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

  /** Scheduling lifecycle. Payment lives on {@link payment_status}, not here. */
  @Column({
    type: 'enum',
    enum: AppointmentStatus,
    default: AppointmentStatus.PENDING_PAYMENT,
  })
  status!: AppointmentStatus;

  /** Payment axis (separate from scheduling) — authoritative "is it paid?". */
  @Column({
    type: 'enum',
    enum: AppointmentPaymentStatus,
    default: AppointmentPaymentStatus.UNPAID,
  })
  payment_status!: AppointmentPaymentStatus;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  total_amount?: number;

  @Column({
    default: 'SAR',
    length: 3,
  })
  currency!: string;

  /** Branch IANA timezone snapshot at booking time — keeps the local wall-time
   *  interpretation stable if the branch timezone is later changed. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  booked_timezone?: string;

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

  /** Optimistic-locking guard — concurrent edits to the same appointment fail
   *  with a version mismatch (mapped to 409) instead of silently lost-updating. */
  @VersionColumn()
  version!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}