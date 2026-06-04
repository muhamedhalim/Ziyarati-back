import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { BillingCycle } from '../enums';

@Entity('subscription_plans')
export class SubscriptionPlan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  price!: string;

  @Column({ type: 'enum', enum: BillingCycle })
  billing_cycle!: BillingCycle;

  @Column({ nullable: true })
  max_branches?: number;

  @Column({ nullable: true })
  max_users?: number;

  @Column({ type: 'bigint', nullable: true })
  max_ai_tokens?: string;

  @Column({ nullable: true })
  max_whatsapp_messages?: number;

  @Column({ nullable: true })
  max_appointments?: number;

  @Column({ nullable: true })
  max_campaigns?: number;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ default: false })
  is_custom!: boolean;
}