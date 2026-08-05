import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
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