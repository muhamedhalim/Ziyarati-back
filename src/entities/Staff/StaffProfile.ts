import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  Unique,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';
import { Tenant } from '../SaaS-Core/Tenant';
import { StaffService } from './StaffService';
import { StaffSchedule } from './StaffSchedule';
import { StaffTimeOff } from './StaffTimeOff';
import { StaffCommission } from './StaffCommission';
import { StaffRating } from './StaffRating';

@Entity('staff_profiles')
@Index(['tenant'])
@Unique('UQ_staff_profiles_public_slug', ['public_slug'])
export class StaffProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  /**
   * Marketplace BE-2 (T060) — stable, GLOBALLY unique public identifier for
   * the flat `/doctors/[doctorSlug]` route (the route has no clinic segment,
   * so per-tenant uniqueness would not be enough — two clinics' "Dr. Ahmed
   * Ali" are a real collision). Name-derived at creation with deterministic
   * numeric disambiguation (`StaffService`), backfilled for existing rows by
   * migration. Assigned once; a later name change does NOT repoint it.
   */
  @Column({ type: 'varchar', length: 160 })
  public_slug!: string;

  @Column({ nullable: true })
  title?: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  bio?: string;

  /**
   * Legacy/external avatar URL for rows created before private storage, OR a
   * short-lived signed URL resolved in-memory from `avatar_storage_key` for
   * API responses (see `StaffService.withResolvedAvatar`) — never both
   * meaningfully at once. The R2 upload flow never accepts an arbitrary
   * external URL going forward; the app only ever clears this column
   * (`StaffService.update` nulls it whenever `avatarStorageKey` changes), it
   * never writes a new URL into it.
   */
  @Column({ type: 'text', nullable: true })
  avatar_url?: string | null;

  /**
   * Private R2 object key (`<tenantId>/staff-avatar/<uuid>.<ext>`). Never a
   * URL. Typed as `| null` (not just optional) because TypeORM's `save()`
   * skips `undefined` properties on UPDATE — clearing this column requires
   * assigning `null` explicitly, not `undefined`.
   */
  @Column({ type: 'varchar', nullable: true })
  avatar_storage_key?: string | null;

  @Column({
    default: 0,
  })
  booking_buffer_minutes!: number;

  @Column({
    default: true,
  })
  is_available_for_booking!: boolean;

  @OneToMany(() => StaffService, (staffService) => staffService.staff)
  staffServices!: StaffService[];

  @OneToMany(() => StaffSchedule, (schedule) => schedule.staff)
  schedules!: StaffSchedule[];

  @OneToMany(() => StaffTimeOff, (timeOff) => timeOff.staff)
  timeOffs!: StaffTimeOff[];

  @OneToMany(() => StaffCommission, (commission) => commission.staff)
  commissions!: StaffCommission[];

  @OneToMany(() => StaffRating, (rating) => rating.staff)
  ratings!: StaffRating[];

  @CreateDateColumn()
  created_at!: Date;

  /** Drives outbound-sync change detection (see IntegrationUpsertService.listDirtyInternal). */
  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
