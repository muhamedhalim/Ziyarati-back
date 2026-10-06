import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export const DELETION_SCOPES = ['SUBJECT', 'TENANT', 'RETENTION'] as const;
export type DeletionScope = (typeof DELETION_SCOPES)[number];

export const DELETION_STATUSES = ['COMPLETED', 'PARTIAL', 'FAILED'] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];

/** What happened to one store during a deletion. Counts and names only. */
export interface DeletionStoreResult {
  /** `database`, `storage`, `cache`, `search_index`. */
  store: string;
  /** Table, bucket prefix or key pattern. */
  target: string;
  /** `deleted`, `anonymised`, `scrubbed`, `retained`, `failed`. */
  action: string;
  affected: number;
  /** Why it was retained / what failed. Never a value from the data. */
  reason?: string;
}

export interface DeletionReport {
  stores: DeletionStoreResult[];
  /** Choices the operator made that change what was deleted (e.g. `clinical: 'retain'`). */
  options?: Record<string, unknown>;
}

/**
 * APPEND-ONLY proof that data was deleted (residency plan P11): which stores
 * were touched, how many rows / objects, what was deliberately retained and why,
 * and what failed. It is the document handed to a clinic, an auditor or a
 * regulator — so it must itself hold no personal data.
 *
 * Like `data_subject_requests`, it has NO foreign keys: it outlives the tenant
 * and the subject it describes. Written for real deletions only; a dry run
 * returns the same report without persisting it.
 */
@Entity('deletion_evidence')
@Index('IDX_deletion_evidence_tenant_created', ['tenant_id', 'created_at'])
export class DeletionEvidence {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  scope!: DeletionScope;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  /** The customer id for a SUBJECT deletion; NULL for TENANT / RETENTION. */
  @Column({ type: 'uuid', nullable: true })
  subject_id?: string | null;

  /** The data-subject request that triggered it, when there was one. */
  @Column({ type: 'uuid', nullable: true })
  request_id?: string | null;

  @Column({ type: 'uuid', nullable: true })
  performed_by_user_id?: string | null;

  @Column({ type: 'varchar', length: 20 })
  status!: DeletionStatus;

  @Column({ type: 'jsonb' })
  report!: DeletionReport;

  @Column({ type: 'timestamptz' })
  started_at!: Date;

  @Column({ type: 'timestamptz' })
  completed_at!: Date;

  @CreateDateColumn()
  created_at!: Date;
}
