import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Tenant } from '../SaaS-Core/Tenant';
import { SubscriptionPlan } from './SubscriptionPlan';
import { SubscriptionStatus } from '../enums';

@Entity('subscriptions')
@Index(['tenant'])
// At most one LIVE subscription per tenant — the rule SubscriptionService.create applies,
// now enforced by the database (migration SubscriptionBillingIntegrityIndexes).
@Index('UQ_subscriptions_live_per_tenant', ['tenant'], {
  unique: true,
  where: `"deleted_at" IS NULL AND "status" <> 'CANCELLED'`,
})
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.subscriptions)
  tenant!: Tenant;

  @ManyToOne(() => SubscriptionPlan)
  plan!: SubscriptionPlan;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.TRIAL,
  })
  status!: SubscriptionStatus;

  @Column({ type: 'timestamptz' })
  starts_at!: Date;

  @Column({ type: 'timestamptz' })
  ends_at!: Date;

  @Column({ default: true })
  auto_renew!: boolean;

  /**
   * Tap migration D4 — a downgrade chosen mid-period. It takes effect at the
   * next renewal (the renewal invoice is priced from it, and settling that
   * invoice switches `plan` to it). NULL = nothing scheduled.
   */
  @ManyToOne(() => SubscriptionPlan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'pending_plan_id',
    foreignKeyConstraintName: 'FK_subscriptions_pending_plan',
  })
  pending_plan?: SubscriptionPlan | null;

  /** FND-031/M-03: when PAST_DUE was entered — the grace boundary is this plus the configured duration. NULL = never entered grace (still active, or terminal). */
  @Column({ type: 'timestamptz', nullable: true })
  grace_started_at?: Date | null;

  /** FND-031/M-03: when GRACE_EXPIRED was entered — makes the transition auditable and verifiable without recomputation. */
  @Column({ type: 'timestamptz', nullable: true })
  grace_expired_at?: Date | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at!: Date;
}