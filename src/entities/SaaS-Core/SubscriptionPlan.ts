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

  // ── Count-based resource caps (nullable = unlimited) ──────────────────────
  // Absolute caps compared against a LIVE count of the resource (not a per-month
  // accumulator). Resolved through UsageService so the plan stays the single
  // source of truth for every limit. Added by migration 1730002000000.
  @Column({ nullable: true })
  max_ai_requests?: number;

  @Column({ nullable: true })
  max_customers?: number;

  @Column({ nullable: true })
  max_crm_contacts?: number;

  @Column({ nullable: true })
  max_conversations?: number;

  @Column({ type: 'bigint', nullable: true })
  max_storage_bytes?: string;

  @Column({ nullable: true })
  max_uploaded_files?: number;

  @Column({ type: 'bigint', nullable: true })
  max_api_calls?: string;

  @Column({ nullable: true })
  max_emails?: number;

  @Column({ nullable: true })
  max_invoices?: number;

  @Column({ nullable: true })
  max_payments?: number;

  @Column({ nullable: true })
  max_transactions?: number;

  @Column({ nullable: true })
  max_knowledge_base_files?: number;

  @Column({ nullable: true })
  max_training_files?: number;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ default: false })
  is_custom!: boolean;
}