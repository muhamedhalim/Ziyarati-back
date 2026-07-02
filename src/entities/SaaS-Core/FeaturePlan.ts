import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Unique,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Feature ↔ subscription-plan availability (many-to-many). A feature with NO
 * rows here is available on ALL plans; otherwise it is available only on the
 * listed plans. `plan_id` references `subscription_plans` (the Subscription
 * Module remains the source of truth for plans) — stored as a scalar to avoid a
 * hard FK across aggregate boundaries.
 */
@Entity('feature_plans')
@Unique(['feature_key', 'plan_id'])
export class FeaturePlan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  feature_key!: string;

  @Column({ type: 'uuid' })
  plan_id!: string;

  @CreateDateColumn()
  created_at!: Date;
}
