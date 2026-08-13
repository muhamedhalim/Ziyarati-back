import { Entity, PrimaryGeneratedColumn, Column, Unique } from 'typeorm';

@Entity('subscription_usage')
@Unique(['subscription_id', 'period_month'])
export class SubscriptionUsage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenant_id!: string;

  /**
   * NULL for a tenant with no subscription — one running on a super-admin
   * feature grant or a free platform. Their usage is still recorded (there is
   * simply no plan limit to compare it against), which is what keeps the
   * platform from being blind to what those clinics consume. A partial unique
   * index on `(tenant_id, period_month) WHERE subscription_id IS NULL` keeps
   * exactly one row per tenant-month on that path.
   */
  @Column({ type: 'uuid', nullable: true })
  subscription_id!: string | null;

  @Column()
  period_month!: string;

  @Column({ type: 'bigint', default: 0 })
  ai_tokens_used!: string;

  @Column({ default: 0 })
  whatsapp_messages_used!: number;

  @Column({ default: 0 })
  appointments_used!: number;

  @Column({ default: 0 })
  campaigns_used!: number;

  @Column({ type: 'timestamptz', nullable: true })
  updated_at?: Date;
}
