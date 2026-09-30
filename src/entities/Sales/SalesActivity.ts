import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';
import { Tenant } from '../SaaS-Core/Tenant';

export const SALES_ACTIVITY_TYPE = [
  'visit',
  'call',
  'meeting',
  'demo',
  'follow_up',
] as const;
export type SalesActivityType = (typeof SALES_ACTIVITY_TYPE)[number];

export const SALES_ACTIVITY_OUTCOME = [
  'interested',
  'not_interested',
  'follow_up_needed',
  'signed_up',
  'no_answer',
] as const;
export type SalesActivityOutcome = (typeof SALES_ACTIVITY_OUTCOME)[number];

/**
 * A field-sales activity (visit, call, meeting, demo, follow-up). The system
 * has NO automatic source for these, so v1 rows are entered by a Super Admin
 * (`source = 'admin_manual'`) and the UI labels them as manually entered. A
 * future rep console would write `source = 'self'` to this same table.
 *
 * `tenant_id` is NULL for a prospect that is not (yet) on the platform, in
 * which case `prospect_name` identifies them. The tenant FK CASCADEs: a
 * purged clinic takes its activity rows with it. (`SET NULL` would collide
 * with `CHK_sales_activities_subject` and block the purge outright.)
 */
@Entity('sales_activities')
@Index('IX_sales_activities_user_occurred', ['sales_user_id', 'occurred_at'], {
  where: `"deleted_at" IS NULL`,
})
@Index('IX_sales_activities_tenant_occurred', ['tenant_id', 'occurred_at'], {
  where: `"deleted_at" IS NULL`,
})
@Check(
  'CHK_sales_activities_type',
  `"type" IN ('visit','call','meeting','demo','follow_up')`,
)
@Check(
  'CHK_sales_activities_outcome',
  `"outcome" IS NULL OR "outcome" IN ('interested','not_interested','follow_up_needed','signed_up','no_answer')`,
)
@Check(
  'CHK_sales_activities_subject',
  `"tenant_id" IS NOT NULL OR "prospect_name" IS NOT NULL`,
)
export class SalesActivity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sales_user_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sales_user_id', foreignKeyConstraintName: 'FK_sales_activities_user' })
  sales_user?: User;

  @Column({ type: 'uuid', nullable: true })
  tenant_id?: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'tenant_id', foreignKeyConstraintName: 'FK_sales_activities_tenant' })
  tenant?: Tenant | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  prospect_name?: string | null;

  @Column({ type: 'varchar', length: 16 })
  type!: SalesActivityType;

  @Column({ type: 'timestamptz' })
  occurred_at!: Date;

  @Column({ type: 'varchar', length: 24, nullable: true })
  outcome?: SalesActivityOutcome | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note?: string | null;

  @Column({ type: 'varchar', length: 16, default: 'admin_manual' })
  source!: string;

  @Column({ type: 'uuid' })
  recorded_by!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'recorded_by', foreignKeyConstraintName: 'FK_sales_activities_recorded_by' })
  recorded_by_user?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at?: Date | null;
}
