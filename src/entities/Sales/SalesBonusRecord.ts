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
import { SalesTarget } from './SalesTarget';
import type { SalesMetric } from './SalesTarget';

export const SALES_BONUS_STATUS = ['approved', 'paid', 'void'] as const;
export type SalesBonusStatus = (typeof SALES_BONUS_STATUS)[number];

/**
 * The auditable, IMMUTABLE record of a bonus that a Super Admin approved. The
 * "draft" state is never stored — it is the live, server-computed preview.
 * Approving recomputes on the server and freezes the numbers here: the target,
 * the achieved value, the rule and the resulting amount. The client never
 * supplies an amount.
 *
 * `paid` is bookkeeping only ("finance told us it was paid") — nothing in the
 * system moves money. `void` unlocks the target for a corrected re-approval,
 * which is why the uniqueness guard excludes void rows.
 */
@Entity('sales_bonus_records')
@Index('UQ_sales_bonus_live_per_target', ['target_id'], {
  unique: true,
  where: `"status" <> 'void'`,
})
@Index('IX_sales_bonus_user_period', ['sales_user_id', 'period_month'])
@Check('CHK_sales_bonus_status', `"status" IN ('approved','paid','void')`)
@Check('CHK_sales_bonus_amount', `"bonus_amount" >= 0`)
export class SalesBonusRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  target_id!: string;

  @ManyToOne(() => SalesTarget, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'target_id', foreignKeyConstraintName: 'FK_sales_bonus_target' })
  target?: SalesTarget;

  @Column({ type: 'uuid' })
  sales_user_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sales_user_id', foreignKeyConstraintName: 'FK_sales_bonus_user' })
  sales_user?: User;

  @Column({ type: 'date' })
  period_month!: string;

  @Column({ type: 'varchar', length: 24 })
  metric!: SalesMetric;

  // ── Frozen calculation basis ───────────────────────────────────────────── //
  @Column({ type: 'numeric', precision: 14, scale: 2 })
  target_value!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  achieved_value!: string;

  @Column({ type: 'numeric', precision: 8, scale: 2 })
  achievement_pct!: string;

  /** The bonus rule as it stood at approval time (type, threshold, amount/percent). */
  @Column({ type: 'jsonb' })
  rule_snapshot!: Record<string, unknown>;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  bonus_amount!: string;

  @Column({ type: 'char', length: 3, nullable: true })
  currency?: string | null;

  @Column({ type: 'varchar', length: 12, default: 'approved' })
  status!: SalesBonusStatus;

  @Column({ type: 'timestamptz' })
  computed_at!: Date;

  @Column({ type: 'uuid' })
  approved_by!: string;

  @Column({ type: 'timestamptz' })
  approved_at!: Date;

  @Column({ type: 'uuid', nullable: true })
  paid_marked_by?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paid_marked_at?: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  void_reason?: string | null;

  @Column({ type: 'uuid', nullable: true })
  voided_by?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  voided_at?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
