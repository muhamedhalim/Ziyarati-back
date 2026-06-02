import { Entity, PrimaryGeneratedColumn, Column, Unique } from 'typeorm';

@Entity('subscription_usage')
@Unique(['subscription_id', 'period_month'])
export class SubscriptionUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenant_id: string;

  @Column()
  subscription_id: string;

  @Column()
  period_month: string;

  @Column({ type: 'bigint', default: 0 })
  ai_tokens_used: string;

  @Column({ default: 0 })
  whatsapp_messages_used: number;

  @Column({ default: 0 })
  appointments_used: number;

  @Column({ default: 0 })
  campaigns_used: number;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at?: Date;
}