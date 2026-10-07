import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { Payment } from '../Payments/Payment';

/**
 * A clinic owner's request to enable a plan-excluded feature or raise a usage
 * limit, quoted by a super admin and paid through the existing Payment
 * flow (there is no wallet/stored-balance entity in this codebase — money
 * movement is always a charge-per-payment, see PaymentService).
 *
 * `type`/`status`/`usage_metric`/`billing_period` are `character varying` + a
 * TS union (not a DB enum) — see billing-upgrade.constants.ts — matching the
 * SupportTicket-era convention so new states never require an `ALTER TYPE`.
 *
 * Money fields are stored in MINOR units (bigint, returned as string by pg —
 * matches `ai_cost_entries.cost_microusd`'s convention), independent of
 * `Payment.amount`'s major-unit `decimal(14,2)` — the boundary conversion
 * happens once, in BillingUpgradeService, when a Payment is created from an
 * accepted quote.
 *
 * Requester/reviewer identity is snapshotted (name/email) so history survives
 * the user being deleted later — same rationale as SupportTicket.
 */
@Entity('billing_upgrade_requests')
export class BillingUpgradeRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => Tenant, { nullable: false })
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  requestedBy?: User;

  @Column({ length: 160, nullable: true })
  requested_by_name?: string;

  @Column({ length: 255, nullable: true })
  requested_by_email?: string;

  /** 'feature' | 'usage_limit' */
  @Column({ length: 24 })
  type!: string;

  /** Required when type = 'feature'. Must exist in the feature catalog. */
  @Column({ nullable: true })
  feature_key?: string;

  /** Required when type = 'usage_limit'. One of USAGE_METRIC (metered metrics only). */
  @Column({ length: 32, nullable: true })
  usage_metric?: string;

  /** Snapshot of usage/limit at request time (null limit = was unlimited). */
  @Column({ type: 'bigint', nullable: true })
  current_usage?: string;

  @Column({ type: 'bigint', nullable: true })
  current_limit?: string;

  /** The owner's requested new absolute limit (usage_limit requests only). */
  @Column({ type: 'bigint', nullable: true })
  requested_quantity?: string;

  /** The super admin's approved new absolute limit — becomes the override value. */
  @Column({ type: 'bigint', nullable: true })
  approved_quantity?: string;

  /** 'pending_review' | 'awaiting_owner_approval' | 'payment_processing' | 'completed' | 'rejected' | 'cancelled' | 'expired' | 'payment_failed' */
  @Index()
  @Column({ length: 32, default: 'pending_review' })
  status!: string;

  @Column({ length: 3, default: 'SAR' })
  currency!: string;

  /** 'one_time' | 'monthly' | 'yearly' — set by the super admin at quote time. */
  @Column({ length: 16, nullable: true })
  billing_period?: string;

  // ── AI advisory estimate (never authoritative — see BillingUpgradeAiEstimateService) ──

  @Column({ type: 'bigint', nullable: true })
  ai_estimated_provider_cost_minor?: string;

  @Column({ type: 'bigint', nullable: true })
  ai_estimated_infra_cost_minor?: string;

  @Column({ type: 'bigint', nullable: true })
  ai_recommended_price_minor?: string;

  /** 0.0000–1.0000 */
  @Column({ type: 'numeric', precision: 5, scale: 4, nullable: true })
  ai_confidence_score?: string;

  @Column({ type: 'jsonb', nullable: true })
  ai_assumptions?: string[];

  @Column({ type: 'jsonb', nullable: true })
  ai_pricing_breakdown?: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  ai_estimate_error?: string;

  @Column({ type: 'timestamptz', nullable: true })
  ai_estimate_generated_at?: Date;

  // ── Super-admin quote (authoritative) ───────────────────────────────────

  /** The FINAL price the owner is charged — set ONLY by the super admin. */
  @Column({ type: 'bigint', nullable: true })
  final_price_minor?: string;

  @Column({ type: 'timestamptz', nullable: true })
  quote_expires_at?: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  reviewer?: User;

  @Column({ length: 160, nullable: true })
  reviewer_name?: string;

  @Column({ type: 'text', nullable: true })
  reviewer_notes?: string;

  // ── Owner acceptance + payment ──────────────────────────────────────────

  @Column({ type: 'timestamptz', nullable: true })
  owner_approved_at?: Date;

  @ManyToOne(() => Payment, { nullable: true, onDelete: 'SET NULL' })
  payment?: Payment;

  /** Denormalised gateway reference for quick display without a join. */
  @Column({ nullable: true })
  payment_reference?: string;

  // ── Terminal outcomes ────────────────────────────────────────────────────

  @Column({ type: 'timestamptz', nullable: true })
  completed_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  rejected_at?: Date;

  @Column({ type: 'text', nullable: true })
  rejection_reason?: string;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at?: Date;

  @Index()
  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
