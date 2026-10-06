import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export const DSR_TYPES = [
  'EXPORT',
  'CORRECTION',
  'DELETION',
  'RESTRICTION',
] as const;
export type DsrType = (typeof DSR_TYPES)[number];

export const DSR_STATUSES = [
  'RECEIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];

/**
 * One data-subject request a clinic has received from a patient (residency plan
 * P13): the audit trail that says a request existed, who handled it, when, and
 * what was done — NOT the data itself.
 *
 * ── DELIBERATELY NO FOREIGN KEYS ────────────────────────────────────────────
 * `tenant_id` and `customer_id` are plain uuids. This row is accountability
 * evidence and must outlive the records it is about: an erased patient is still
 * proof that the request was honoured, and a deleted tenant's trail must not
 * block (or be cascaded away by) offboarding.
 *
 * ── NO PERSONAL DATA IN THE ROW ─────────────────────────────────────────────
 * Only ids, enums, timestamps and counts. `note` is length-capped and is for the
 * handler's procedural remarks; the service rejects obvious identifiers in it.
 */
@Entity('data_subject_requests')
@Index('IDX_dsr_tenant_received', ['tenant_id', 'received_at'])
@Index('IDX_dsr_tenant_customer', ['tenant_id', 'customer_id'])
export class DataSubjectRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'uuid' })
  customer_id!: string;

  @Column({ type: 'varchar', length: 20 })
  type!: DsrType;

  @Column({ type: 'varchar', length: 20, default: 'RECEIVED' })
  status!: DsrStatus;

  /** How it reached the clinic (`in_person`, `email`, `phone`, `portal`, `other`). */
  @Column({ type: 'varchar', length: 30 })
  channel!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  received_at!: Date;

  /**
   * Response deadline. NULL unless `DSR_RESPONSE_DAYS` is configured: the legal
   * period is a counsel input (plan L-series) and is never assumed here.
   */
  @Column({ type: 'timestamptz', nullable: true })
  due_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at?: Date | null;

  /** Staff user who logged the request. */
  @Column({ type: 'uuid', nullable: true })
  requested_by_user_id?: string | null;

  /** Staff user who fulfilled / closed it. */
  @Column({ type: 'uuid', nullable: true })
  handled_by_user_id?: string | null;

  /** Procedural remark only — never the patient's data. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  note?: string | null;

  /** Counts and choices only (e.g. `{ clinical: 'retain', recordsExported: 12 }`). */
  @Column({ type: 'jsonb', nullable: true })
  outcome?: Record<string, unknown> | null;

  /** The `deletion_evidence` row, for a DELETION request. */
  @Column({ type: 'uuid', nullable: true })
  evidence_id?: string | null;

  @CreateDateColumn()
  created_at!: Date;
}
