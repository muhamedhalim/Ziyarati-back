import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';
import { Tenant } from '../SaaS-Core/Tenant';

export const SALES_ASSIGNMENT_KIND = ['acquired', 'managed'] as const;
export type SalesAssignmentKind = (typeof SALES_ASSIGNMENT_KIND)[number];

export const SALES_ASSIGNMENT_END_REASON = [
  'unassigned',
  'reassigned',
  'transferred',
] as const;
export type SalesAssignmentEndReason =
  (typeof SALES_ASSIGNMENT_END_REASON)[number];

/**
 * Sales ownership of a clinic (tenant), with full history. A row is CLOSED
 * (`ended_at` set), never deleted, when a clinic is unassigned, reassigned or
 * transferred — so revenue attribution and "who owned this clinic when" stay
 * answerable after the fact.
 *
 * Every guard below is declared HERE as well as in migration
 * `SalesStaffManagement1730105000000`, so a schema built from entity metadata
 * carries the same integrity guarantees (P0.2/P0.3: guards that live only in
 * raw migration SQL are silently lost on a synchronize boot).
 *
 * - `UQ_sales_assignment_active_tenant`: a clinic has AT MOST ONE active
 *   owner. It is also the race guard — two concurrent assigns of one clinic
 *   cannot both commit (23505 → 409 in the service).
 * - `UQ_sales_assignment_acquired_tenant`: acquisition credit for a clinic is
 *   granted once, ever. A later reassignment opens a `managed` row.
 */
@Entity('sales_clinic_assignments')
@Index('UQ_sales_assignment_active_tenant', ['tenant_id'], {
  unique: true,
  where: `"ended_at" IS NULL`,
})
@Index('UQ_sales_assignment_acquired_tenant', ['tenant_id'], {
  unique: true,
  where: `"kind" = 'acquired'`,
})
@Index('IX_sales_assignment_user_active', ['sales_user_id', 'assigned_at'], {
  where: `"ended_at" IS NULL`,
})
@Index('IX_sales_assignment_user_assigned', ['sales_user_id', 'assigned_at'])
@Index('IX_sales_assignment_tenant_history', ['tenant_id', 'assigned_at'])
@Check('CHK_sales_assignment_kind', `"kind" IN ('acquired','managed')`)
@Check(
  'CHK_sales_assignment_end_reason',
  `"end_reason" IS NULL OR "end_reason" IN ('unassigned','reassigned','transferred')`,
)
@Check(
  'CHK_sales_assignment_period',
  `"ended_at" IS NULL OR "ended_at" >= "assigned_at"`,
)
export class SalesClinicAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sales_user_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sales_user_id', foreignKeyConstraintName: 'FK_sales_assignment_user' })
  sales_user?: User;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'FK_sales_assignment_tenant' })
  tenant?: Tenant;

  @Column({ type: 'varchar', length: 16 })
  kind!: SalesAssignmentKind;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  assigned_at!: Date;

  /** NULL = the assignment is active. */
  @Column({ type: 'timestamptz', nullable: true })
  ended_at?: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  end_reason?: SalesAssignmentEndReason | null;

  @Column({ type: 'uuid', nullable: true })
  assigned_by?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assigned_by', foreignKeyConstraintName: 'FK_sales_assignment_assigned_by' })
  assigned_by_user?: User | null;

  @Column({ type: 'uuid', nullable: true })
  ended_by?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'ended_by', foreignKeyConstraintName: 'FK_sales_assignment_ended_by' })
  ended_by_user?: User | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
