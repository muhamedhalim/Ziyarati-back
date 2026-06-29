import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Immutable audit trail for verification-document actions.
 *
 * Uses plain scalar columns (no FK relations) on purpose: the trail must survive
 * deletion of the tenant or document it references, and must never be mutated.
 * Every privileged action — upload, replace, delete, view/download (signed-URL
 * issuance), approve, reject, submit-for-review — appends one row here.
 */
@Entity('verification_audit_logs')
@Index(['tenant_id', 'created_at'])
export class VerificationAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'uuid', nullable: true })
  document_id?: string;

  /** One of VerificationAuditAction (stored as text for forward-compat). */
  @Column()
  action!: string;

  @Column({ nullable: true })
  doc_type?: string;

  @Column({ type: 'uuid', nullable: true })
  actor_id?: string;

  @Column({ nullable: true })
  actor_role?: string;

  @Column({ nullable: true })
  ip_address?: string;

  @Column({ type: 'text', nullable: true })
  user_agent?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  created_at!: Date;
}
