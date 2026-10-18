import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { Branch } from './Branch';

export enum TenantTargetType {
  APPOINTMENTS = 'APPOINTMENTS',
  REVENUE = 'REVENUE',
}

/**
 * One monthly goal for one scope.
 *
 * Scope: `branch_id` set = that branch's goal; `branch_id` NULL = the
 * clinic-wide (organisation-level) goal. They are separate rows, never a
 * fallback for one another — hence TWO partial unique indexes (a single
 * composite one would treat NULL branches as distinct and allow duplicates).
 *
 * Period: `period_month` is `'YYYY-MM'` (UTC calendar month, the same
 * representation as `MonthlyReport.period_month`) — NOT derived from
 * `created_at`.
 */
@Entity('tenant_targets')
@Check('CHK_tenant_targets_type', `"target_type" IN ('APPOINTMENTS','REVENUE')`)
@Check(
  'CHK_tenant_targets_period',
  `"period_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
)
@Check('CHK_tenant_targets_value', `"value" >= 0 AND "original_value" >= 0`)
@Index(
  'uq_tenant_targets_branch',
  ['tenant_id', 'branch_id', 'target_type', 'period_month'],
  {
    unique: true,
    where: '"branch_id" IS NOT NULL',
  },
)
@Index('uq_tenant_targets_org', ['tenant_id', 'target_type', 'period_month'], {
  unique: true,
  where: '"branch_id" IS NULL',
})
export class TenantTarget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ type: 'uuid', nullable: true })
  branch_id!: string | null;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'branch_id' })
  branch?: Branch | null;

  @Column({ type: 'varchar', length: 16 })
  target_type!: TenantTargetType;

  @Column({ type: 'varchar', length: 7 })
  period_month!: string;

  /** Current value. numeric(14,2) comes back as a string — never a float. */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  value!: string;

  /** The value this target was first created with — never rewritten. */
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  original_value!: string;

  @Column({ type: 'uuid', nullable: true })
  created_by!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updated_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
