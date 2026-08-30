import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T130).
 *
 * A per-CLINIC suppression list for marketing email (FR-E005/E007/E008/E019).
 * `email` is ALWAYS stored lowercased (normalized by `EmailSuppressionService`
 * before every read/write) so the UNIQUE (tenant, email) constraint and every
 * lookup are case-insensitive without a functional index.
 *
 * Suppression is deliberately per-TENANT, never global: one clinic's bad list
 * (or a patient who unsubscribed from one clinic) must never silently block a
 * DIFFERENT clinic's marketing to the same address (see the migration's own
 * docblock for the constraint that enforces this).
 *
 * This table is consulted ONLY by the marketing dispatch path
 * (`CampaignDispatchService.checkConsent`) — never by transactional mail
 * (reminders, receipts, confirmations), which is FR-E009's hard requirement.
 */
@Entity('email_suppressions')
@Index('IDX_email_suppressions_tenant', ['tenant'])
export class EmailSuppression {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  /** Always lowercased before persistence — see class docblock. */
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  /** `bounce` | `complaint` | `unsubscribe` | `manual` — free-form, not an enum, mirroring `failure_reason`'s style elsewhere in this module. */
  @Column({ type: 'varchar', length: 32 })
  reason!: string;

  /** `webhook` | `unsubscribe_link` | `manual` — how the suppression was registered, for audit. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  source?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
