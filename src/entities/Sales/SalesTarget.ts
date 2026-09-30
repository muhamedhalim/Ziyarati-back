import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';

export const SALES_METRIC = [
  'new_clinics',
  'subscription_revenue',
  'paid_conversions',
] as const;
export type SalesMetric = (typeof SALES_METRIC)[number];

export const SALES_BONUS_TYPE = [
  'none',
  'fixed_on_threshold',
  'percent_of_achieved',
] as const;
export type SalesBonusType = (typeof SALES_BONUS_TYPE)[number];

/**
 * One monthly target for one sales employee and one metric. `period_month`
 * is the FIRST DAY of a UTC calendar month. The bonus RULE lives on the
 * target (what the admin configured); the bonus AMOUNT is never stored here —
 * it is computed on the server and, once approved, frozen in
 * `sales_bonus_records`.
 *
 * `version` is optimistic concurrency: two admins editing the same target
 * cannot silently overwrite each other. Every change also writes a
 * `sales_target_revisions` row in the same transaction.
 */
@Entity('sales_targets')
@Unique('UQ_sales_targets_user_period_metric', [
  'sales_user_id',
  'period_month',
  'metric',
])
@Index('IX_sales_targets_period', ['period_month', 'sales_user_id'])
@Check(
  'CHK_sales_targets_metric',
  `"metric" IN ('new_clinics','subscription_revenue','paid_conversions')`,
)
@Check(
  'CHK_sales_targets_period_first_day',
  `EXTRACT(DAY FROM "period_month") = 1`,
)
@Check('CHK_sales_targets_value', `"target_value" >= 0`)
@Check(
  'CHK_sales_targets_currency',
  `("metric" = 'subscription_revenue') = ("currency" IS NOT NULL)`,
)
@Check(
  'CHK_sales_targets_bonus_type',
  `"bonus_type" IN ('none','fixed_on_threshold','percent_of_achieved')`,
)
@Check(
  'CHK_sales_targets_bonus_shape',
  `("bonus_type" = 'none' AND "bonus_amount" IS NULL AND "bonus_percent" IS NULL) OR ("bonus_type" = 'fixed_on_threshold' AND "bonus_amount" IS NOT NULL AND "bonus_percent" IS NULL AND "bonus_threshold_pct" IS NOT NULL) OR ("bonus_type" = 'percent_of_achieved' AND "bonus_percent" IS NOT NULL AND "bonus_amount" IS NULL AND "metric" = 'subscription_revenue')`,
)
export class SalesTarget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sales_user_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sales_user_id', foreignKeyConstraintName: 'FK_sales_targets_user' })
  sales_user?: User;

  /** 'YYYY-MM-01' — a DATE, returned by the driver as a string. */
  @Column({ type: 'date' })
  period_month!: string;

  @Column({ type: 'varchar', length: 24 })
  metric!: SalesMetric;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  target_value!: string;

  /** Required iff the metric is `subscription_revenue`. */
  @Column({ type: 'char', length: 3, nullable: true })
  currency?: string | null;

  @Column({ type: 'varchar', length: 24, default: 'none' })
  bonus_type!: SalesBonusType;

  @Column({ type: 'numeric', precision: 6, scale: 2, nullable: true })
  bonus_threshold_pct?: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  bonus_amount?: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  bonus_percent?: string | null;

  @Column({ type: 'char', length: 3, nullable: true })
  bonus_currency?: string | null;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'uuid', nullable: true })
  created_by?: string | null;

  @Column({ type: 'uuid', nullable: true })
  updated_by?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
