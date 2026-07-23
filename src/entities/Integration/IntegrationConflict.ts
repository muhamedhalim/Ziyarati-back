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
import { IntegrationConnection } from './IntegrationConnection';

/**
 * A PERSISTED write conflict awaiting (or having received) a resolution
 * (Phase 4). Created when the write pipeline's conflict decision is `report`
 * (the `reject_and_report` policy, or a flagged divergence) so a divergence is
 * never silently dropped and can be reviewed and resolved later through the
 * SHARED write service — never by direct repository mutation.
 *
 * Stores ONLY safe review metadata: the ids, the NAMES of the conflicting
 * fields, and short one-way hashes of the two sides so a reviewer can tell
 * "these still differ" WITHOUT the actual (possibly protected/sensitive) values
 * ever being persisted or exposed. Protected fields and full records are never
 * stored here.
 */
@Entity('integration_conflicts')
@Index('IX_integration_conflicts_lookup', ['tenant', 'connection', 'resource_type', 'status'])
export class IntegrationConflict {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  /** SET NULL (not CASCADE) so conflict history survives a connection removal. */
  @ManyToOne(() => IntegrationConnection, { nullable: true, onDelete: 'SET NULL' })
  connection?: IntegrationConnection | null;

  /** customer | staff | service | appointment */
  @Column({ type: 'varchar', length: 20 })
  resource_type!: string;

  @Column({ type: 'varchar', length: 255 })
  external_id!: string;

  @Column({ type: 'uuid', nullable: true })
  internal_resource_id?: string | null;

  /** Names only of the fields in conflict — never their values. */
  @Column({ type: 'jsonb' })
  conflicting_fields!: string[];

  /** SHA-256 (truncated) of the incoming external values for the changed fields. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  external_hash?: string | null;

  /** SHA-256 (truncated) of the current platform values for the changed fields. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  platform_hash?: string | null;

  /** The connection's conflict policy in effect when the conflict was raised. */
  @Column({ type: 'varchar', length: 24 })
  policy!: string;

  /**
   * Safe machine-readable reason code (never free-form external text), e.g.
   * `field_divergence`, `staff_requires_account`, `missing_dependency`. Lets the
   * review UI explain WHY a record could not be applied without exposing values.
   */
  @Column({ type: 'varchar', length: 48, default: 'field_divergence' })
  reason!: string;

  /** pending | resolved | ignored */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  /**
   * How it was resolved (set when status leaves `pending`):
   * external_wins | platform_wins | ignored.
   */
  @Column({ type: 'varchar', length: 24, nullable: true })
  resolution?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  resolved_by?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at?: Date | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
