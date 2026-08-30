import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { Customer } from '../CRM/Customer';
import { StaffProfile } from '../Staff/StaffProfile';
import { Appointment } from './Appointment';
import { User } from '../Auth&RBAC/User';
import { QueueState } from '../enums';

/**
 * Spec 014 (Clinic Platform Completion) — T168 (US10, data-model.md §1.10).
 * A branch's live, per-day walk-in/check-in queue. Queue management does NOT
 * replace the appointment lifecycle (FR-Q004): `PatientQueueService` drives
 * the EXISTING `AppointmentsService.changeStatus`/`cancel` for every
 * transition that has an appointment-side equivalent, so a completion or
 * no-show recorded through the queue produces exactly one status-log row,
 * one history row and one event — never a second, queue-only write.
 *
 * FR-Q005's "checking in the same appointment twice must not create a
 * second queue entry" is a DATABASE constraint
 * (`UQ_queue_entries_appointment_live`, declared here AND in the migration —
 * same pattern as `WaitlistEntry`'s `UQ_waitlist_entries_active_dup`), not an
 * application-level pre-check: a pre-check races two concurrent check-ins for
 * the same appointment; only a partial unique index closes that race.
 *
 * `position` is DELIBERATELY not a column — FR-Q008 derives it at read time
 * from `appointment.start_at` then `arrived_at` (see `queue-ordering.ts`), so
 * nothing ever needs renumbering when an entry changes state.
 */
@Entity('queue_entries')
@Index('IDX_queue_entries_live', ['tenant', 'branch', 'business_date', 'state'])
@Index('IDX_queue_entries_staff', [
  'tenant',
  'branch',
  'business_date',
  'staff',
])
@Index('UQ_queue_entries_appointment_live', ['tenant', 'appointment'], {
  unique: true,
  where: `"state" NOT IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')`,
})
export class QueueEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  /** Scope of the queue (FR-Q014) — always the appointment's own branch. */
  @ManyToOne(() => Branch)
  branch!: Branch;

  @ManyToOne(() => Appointment)
  appointment!: Appointment;

  @ManyToOne(() => Customer)
  customer!: Customer;

  /** Practitioner view scope (FR-Q013). */
  @ManyToOne(() => StaffProfile, { nullable: true })
  staff?: StaffProfile | null;

  /** Branch-local day the queue belongs to — the queue is per branch PER DAY. */
  @Column({ type: 'date' })
  business_date!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: QueueState.WAITING,
  })
  state!: QueueState;

  @Column({ type: 'timestamptz' })
  arrived_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  called_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  started_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at?: Date | null;

  @ManyToOne(() => User, { nullable: true })
  called_by?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
