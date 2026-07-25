import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { StaffProfile } from '../Staff/StaffProfile';
import { IntegrationConnection } from './IntegrationConnection';

/**
 * A REVIEWABLE request to provision a staff member that an external system
 * reported but the platform has no account for (Phase 4).
 *
 * WHY THIS EXISTS. `staff_profiles.user_id` is a required 1:1 to `users`, so
 * "import a staff member" unavoidably means "create a login identity, assign it
 * a role, and consume a plan seat". That is a privileged decision about who may
 * sign in to a clinic, and an external PMS is not entitled to make it. But
 * failing every new staff import would make staff sync useless — so an import
 * lands HERE instead: a durable, safe, reviewable request that a tenant admin
 * approves (choosing the role) or rejects.
 *
 * Approval then runs the platform's EXISTING provisioning + invitation flow.
 * Nothing here is a second authentication path: this row never holds a
 * credential, never grants access on its own, and cannot assign a role by
 * itself — the role is chosen by the approving admin and validated against the
 * tenant's assignable-role policy at approval time.
 *
 * WHAT IS STORED: only the identity fields needed to review and then provision —
 * name, email, and the allowlisted profile fields (title/bio/booking prefs).
 * Never a password, role, permission, commission, payout, rating, or any other
 * platform-owned field.
 */
@Entity('integration_staff_provisioning')
@Index('IX_integration_staff_provisioning_lookup', ['tenant', 'connection', 'status'])
export class IntegrationStaffProvisioning {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  /** SET NULL so a reviewed request survives the connection being removed. */
  @ManyToOne(() => IntegrationConnection, { nullable: true, onDelete: 'SET NULL' })
  connection?: IntegrationConnection | null;

  /** The external system's id for this staff member — the dedupe key. */
  @Column({ type: 'varchar', length: 255 })
  external_id!: string;

  /**
   * pending  — awaiting review.
   * ambiguous— more than one internal candidate matched; a human must pick.
   * approved — provisioned; `staff_profile` and `created_user` are set.
   * rejected — declined by an admin; no account was created.
   * linked   — resolved by linking to an existing staff member instead.
   */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  /** Proposed full name from the external system (display only until approved). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  proposed_full_name?: string | null;

  /**
   * Proposed login email. Reviewed, never trusted: at approval the platform
   * re-checks it is free within the tenant, so an import can never take over an
   * existing account by claiming its address.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  proposed_email?: string | null;

  /**
   * Allowlisted PROFILE fields only (title/bio/booking preferences) — the same
   * set an integration may write on an existing staff member.
   */
  @Column({ type: 'jsonb', nullable: true })
  proposed_profile?: Record<string, unknown> | null;

  /**
   * Internal staff ids that matched this external record. Populated when the
   * match was AMBIGUOUS (>1) so a reviewer can choose rather than the platform
   * guessing between two real people.
   */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  candidate_staff_ids!: string[];

  /** Role slug the approver selected. Never supplied by the external system. */
  @Column({ type: 'varchar', length: 60, nullable: true })
  approved_role_slug?: string | null;

  /** Staff profile this request resolved to (approved or linked). */
  @ManyToOne(() => StaffProfile, { nullable: true, onDelete: 'SET NULL' })
  staff_profile?: StaffProfile | null;

  /** User account created by approval, when approval created one. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  created_user?: User | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  reviewed_by?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at?: Date | null;

  /** True once the set-password invitation has been dispatched. */
  @Column({ type: 'boolean', default: false })
  invitation_sent!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  invitation_sent_at?: Date | null;

  /** Safe, truncated note (rejection reason or failure summary). Never secrets. */
  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
