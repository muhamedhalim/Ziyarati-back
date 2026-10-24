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
  Exclusion,
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
import {
  AppointmentSource,
  AppointmentStatus,
  AppointmentPaymentStatus,
} from '../enums';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

@Entity('appointments')
@Index(['tenant', 'branch', 'start_at'])
@Index(['staff', 'start_at'])
@Index(['customer', 'start_at'])
@Index(['branch', 'status', 'start_at']) // status-filtered calendar queries
/**
 * 015-db-api-efficiency-audit — P9/T060 (IDX-002, evidence in
 * evidence/p9-t058-explain-captures-2026-08-31.md). Serves
 * `AppointmentService.findAll`'s DEFAULT list (`WHERE tenant ORDER BY
 * start_at DESC LIMIT/OFFSET`, no branch filter) — the existing `(tenant,
 * branch, start_at)` index above only helps when a branch is also filtered;
 * without one, Postgres fetched every one of the tenant's rows and sorted
 * them in memory. Measured: Bitmap Heap Scan + top-N sort (39 buffers) →
 * Index Scan, no sort (3 buffers) on a 1,200-row tenant.
 */
@Index(['tenant', 'start_at'])
@Index(
  'IDX_appointments_tenant_follow_up_due',
  ['tenant', 'follow_up_due_on'],
  {
    where: '"follow_up_due_on" IS NOT NULL AND "deleted_at" IS NULL',
  },
)
@Check('appointments_end_after_start', '"end_at" > "start_at"')
@Check(
  'appointments_total_nonneg',
  '"total_amount" IS NULL OR "total_amount" >= 0',
)
/**
 * P0.1 — the race-proof double-booking guard, declared here so that TypeORM
 * KNOWS ABOUT IT.
 *
 * The constraint is created by migration (`AppointmentNoOverlap
 * 1730001100000`, repaired by `AppointmentNoOverlapRepair1730088000000`) and
 * that remains its source of truth for production, where `synchronize` is a
 * hard boot error. This decorator exists for a different reason: TypeORM's
 * schema synchronizer drops every EXCLUDE constraint it finds in the database
 * but not in entity metadata (`RdbmsSchemaBuilder.dropOldExclusions`). Until
 * this declaration existed, EVERY `TYPEORM_SYNCHRONIZE=true` boot silently
 * issued
 *
 *     ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_overlap"
 *
 * against a correctly-migrated database, leaving the `migrations` row in place
 * and the guarantee gone — which is exactly how a 500-VU contention run put 495
 * appointments into one doctor's 15-minute slot, all HTTP 201.
 *
 * The synchronizer matches exclusion constraints BY NAME, so the name here MUST
 * stay byte-identical to the migration's. The expression is everything after
 * `EXCLUDE` (see `PostgresQueryRunner.createExclusionConstraintSql`) and is
 * kept character-for-character in step with the migration, so a database built
 * by `synchronize` gets the SAME guard rather than a lookalike.
 *
 * Consequence worth knowing: on a synchronize-built database that already
 * contains overlapping rows, boot now FAILS on this ALTER instead of quietly
 * permitting double-booking. That is the intended trade — and it cannot affect
 * production, which never synchronizes.
 */
@Exclusion(
  'appointments_no_overlap',
  `USING gist ("staffId" WITH =, tstzrange("start_at", "end_at", '[)') WITH &&) ` +
    `WHERE (status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL)`,
)
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

  /** Calendar date (no time, no zone) a clinician asked the patient to return by.
   *  Set only by a person, only on a COMPLETED appointment; drives the follow-up rule. */
  @Column({ type: 'date', nullable: true })
  follow_up_due_on?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'follow_up_set_by_id' })
  follow_up_set_by?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  follow_up_set_at?: Date | null;

  @OneToMany(() => AppointmentService, (service) => service.appointment)
  services!: AppointmentService[];

  @OneToMany(() => AppointmentHistory, (history) => history.appointment)
  history!: AppointmentHistory[];

  @OneToMany(() => AppointmentStatusLog, (log) => log.appointment)
  statusLogs!: AppointmentStatusLog[];

  @OneToMany(() => AppointmentNote, (note) => note.appointment)
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
