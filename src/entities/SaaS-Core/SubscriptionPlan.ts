import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { BillingCycle, CustomCycleUnit } from '../enums';

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

  /**
   * Cycle length when `billing_cycle` is CUSTOM, e.g. `3` + MONTH = "every 3
   * months". Null for MONTHLY/YEARLY plans. Frozen alongside `billing_cycle`
   * once a plan has active subscribers — see `PlanAdminService.toTermPatch`.
   */
  @Column({ type: 'int', nullable: true })
  custom_cycle_value?: number | null;

  @Column({ type: 'enum', enum: CustomCycleUnit, nullable: true })
  custom_cycle_unit?: CustomCycleUnit | null;

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

  @Column({ type: 'bigint', nullable: true })
  max_uploaded_files?: string;

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

  @Column({ type: 'bigint', nullable: true })
  max_training_files?: string;

  /**
   * Declares a NULL limit column as intentionally unlimited (Phase 0.2,
   * plan §8) — e.g. `{ "max_customers": "unlimited" }`. Absence of a key
   * (with the column still NULL) means "not configured", not "unlimited".
   * See `PlanLimitStatusService`.
   */
  @Column({ type: 'jsonb', nullable: true })
  limit_declarations?: Record<string, 'unlimited'> | null;

  @Column({ default: true })
  is_active!: boolean;

  @Column({ default: false })
  is_custom!: boolean;
}