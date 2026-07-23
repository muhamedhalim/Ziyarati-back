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
 * One synchronization run for a (connection, resource, direction) (Phase 4).
 *
 * This table is BOTH the live job and the run history — each manual/scheduled
 * sync inserts a new row, so querying the table by (connection, resource,
 * direction) ordered by time gives the full run history, the last successful
 * cursor, and the last failure without a second table.
 *
 * A PARTIAL UNIQUE INDEX (see the migration) enforces at the DATABASE level that
 * only ONE row per (tenant, connection, resource_type, direction) may be in an
 * active state (`pending`/`running`) at a time — duplicate-active-job prevention
 * that a service-level check alone could race past.
 *
 * Handlers are IDEMPOTENT and safely retryable; we never claim exactly-once.
 * Only SAFE fields are stored (counts, cursor token, truncated error) — never
 * record content, secrets, or raw queue internals.
 */
@Entity('integration_sync_jobs')
@Index('IX_integration_sync_jobs_lookup', ['tenant', 'connection', 'resource_type', 'direction'])
export class IntegrationSyncJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  /** SET NULL (not CASCADE) so sync history survives a connection removal. */
  @ManyToOne(() => IntegrationConnection, { nullable: true, onDelete: 'SET NULL' })
  connection?: IntegrationConnection | null;

  /** customer | staff | service | appointment */
  @Column({ type: 'varchar', length: 20 })
  resource_type!: string;

  /** inbound | outbound (bidirectional connections run one row per direction). */
  @Column({ type: 'varchar', length: 20 })
  direction!: string;

  /** full | incremental */
  @Column({ type: 'varchar', length: 16, default: 'incremental' })
  mode!: string;

  /**
   * pending | running | partially_completed | completed | failed | cancelled.
   * A PARTIAL UNIQUE INDEX on (tenant, connection, resource_type, direction)
   * WHERE status IN ('pending','running') — see the migration — guarantees at the
   * DATABASE level that only one active run per tuple can exist.
   */
  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: string;

  /** Watermark this run STARTED from (the prior last_successful_cursor). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  cursor?: string | null;

  /** Watermark last successfully persisted by this run (resume point). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  last_successful_cursor?: string | null;

  @Column({ type: 'int', default: 0 })
  processed!: number;

  @Column({ type: 'int', default: 0 })
  created_count!: number;

  @Column({ type: 'int', default: 0 })
  updated_count!: number;

  @Column({ type: 'int', default: 0 })
  skipped_count!: number;

  @Column({ type: 'int', default: 0 })
  conflicted_count!: number;

  @Column({ type: 'int', default: 0 })
  failed_count!: number;

  @Column({ type: 'int', default: 0 })
  retry_count!: number;

  @Column({ type: 'boolean', default: false })
  cancel_requested!: boolean;

  @Column({ type: 'text', nullable: true })
  error_summary?: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  triggered_by?: User | null;

  /** true when a scheduler (not a tenant admin) started the run. */
  @Column({ type: 'boolean', default: false })
  scheduled!: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  correlation_id?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  started_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at?: Date | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
