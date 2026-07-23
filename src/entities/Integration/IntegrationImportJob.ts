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
 * A queued (async) batch-import job (Phase 4 — two-way integrations).
 *
 * The HTTP request validates, persists THIS row (status `pending`), enqueues a
 * BullMQ job, and returns the tenant-facing `id` immediately — the row is the
 * durable source of truth, never a raw queue id. The worker processes items
 * through the SHARED write pipeline (no second mutation path), updating counts +
 * progress here so the run is observable and safely recoverable after a worker
 * restart.
 *
 * Stores only SAFE metadata: counts, progress, a truncated error summary, the
 * requester and a correlation reference. It never stores secrets, full records,
 * medical notes, or payment data — per-record content lives only in the request
 * payload snapshot (see `payload_ref`) which is itself size-bounded and dropped
 * once terminal.
 */
@Entity('integration_import_jobs')
@Index('IX_integration_import_jobs_tenant', ['tenant'])
@Index('IX_integration_import_jobs_connection', ['connection'])
export class IntegrationImportJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  /**
   * SET NULL (not CASCADE) on connection removal so an import's history is never
   * destroyed by a connection delete. Disconnect is a soft-delete, so in normal
   * operation this stays populated.
   */
  @ManyToOne(() => IntegrationConnection, { nullable: true, onDelete: 'SET NULL' })
  connection?: IntegrationConnection | null;

  /** customer | staff | service | appointment */
  @Column({ type: 'varchar', length: 20 })
  resource_type!: string;

  /** pending | running | partially_completed | completed | failed | cancelled */
  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status!: string;

  /** partial | atomic (atomic only when transactional support exists). */
  @Column({ type: 'varchar', length: 16, default: 'partial' })
  mode!: string;

  @Column({ type: 'boolean', default: false })
  dry_run!: boolean;

  /** Total records accepted into the job. */
  @Column({ type: 'int', default: 0 })
  total!: number;

  /** Records processed so far (drives progress; monotonic). */
  @Column({ type: 'int', default: 0 })
  processed!: number;

  @Column({ type: 'int', default: 0 })
  created_count!: number;

  @Column({ type: 'int', default: 0 })
  updated_count!: number;

  @Column({ type: 'int', default: 0 })
  linked_count!: number;

  @Column({ type: 'int', default: 0 })
  skipped_count!: number;

  @Column({ type: 'int', default: 0 })
  conflicted_count!: number;

  @Column({ type: 'int', default: 0 })
  failed_count!: number;

  @Column({ type: 'int', default: 0 })
  duplicates_in_batch!: number;

  /** Cancellation requested by a tenant admin; honored at the next item boundary. */
  @Column({ type: 'boolean', default: false })
  cancel_requested!: boolean;

  /**
   * SERVER-ONLY staged records the worker consumes. Held ONLY while the job is
   * in-flight and CLEARED the moment the job reaches a terminal state, so record
   * content is never retained long-term. Never serialized to any client (same
   * discipline as `credentials_ciphertext`). Size-bounded at accept time.
   */
  @Column({ type: 'jsonb', nullable: true, select: false })
  payload?: Array<{ externalId: string; data: Record<string, unknown> }> | null;

  /** Safe, truncated error summary (never secrets / full records). */
  @Column({ type: 'text', nullable: true })
  error_summary?: string | null;

  /** Who requested the import (for audit). */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  requested_by?: User | null;

  /** Correlation/request reference to tie API → queue → worker in logs. */
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
