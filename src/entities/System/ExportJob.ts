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
import { ExportJobFormat, ExportJobState } from '../enums';

/**
 * Spec 014 (Clinic Platform Completion) — T179 (US13, data-model.md §1.11,
 * contracts/clinic-surfaces.md F13).
 *
 * Tracks one report-export request. `filters` and `branch_scope` are
 * captured from the requester AT REQUEST TIME (in `ReportExportService`,
 * T181) and never re-derived — a later permission change (e.g. a
 * branch-restricted user's scope narrowing) cannot widen an already-queued
 * export, because generation only ever reads these frozen columns, never a
 * live caller. `branch_scope` mirrors `AdvancedAnalyticsService.resolveScope`'s
 * `{ branchId?: string }` shape (FR-A016's existing branch-restriction
 * resolution, reused rather than reinvented) — `null` for a tenant-wide
 * caller who requested no branch filter.
 *
 * `report` is a varchar, not a DB enum: it is validated against the CLOSED
 * registry in `export-registry.ts` at the application layer (T180) — adding
 * a new exportable report must never require a migration.
 */
@Entity('export_jobs')
@Index('IDX_export_jobs_tenant_requested_created', [
  'tenant',
  'requestedBy',
  'created_at',
])
@Index('IDX_export_jobs_state_expires', ['state', 'expires_at'])
export class ExportJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: false })
  requestedBy!: User;

  /** Closed registry key (export-registry.ts) — never a caller-supplied query/table name. */
  @Column({ type: 'varchar', length: 60 })
  report!: string;

  @Column({ type: 'varchar', length: 10, default: ExportJobFormat.XLSX })
  format!: ExportJobFormat;

  /** Exactly the filters the on-screen report used (FR-X001), frozen at request time. */
  @Column({ type: 'jsonb' })
  filters!: Record<string, unknown>;

  /** The requester's effective branch scope, captured at request time. Null = tenant-wide. */
  @Column({ type: 'jsonb', nullable: true })
  branch_scope!: { branchId?: string } | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: ExportJobState.PENDING,
  })
  state!: ExportJobState;

  /** Private, tenant-prefixed storage key — set once the file is written (READY). */
  @Column({ type: 'varchar', nullable: true })
  storage_key!: string | null;

  @Column({ type: 'int', nullable: true })
  row_count!: number | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
