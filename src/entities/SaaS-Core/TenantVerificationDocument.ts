import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { VerificationDocStatus } from '../enums';

@Entity('tenant_verification_documents')
@Index(['tenant'])
export class TenantVerificationDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (t) => t.verificationDocuments, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  doc_type!: string;

  /**
   * Legacy/external file URL. Nullable since the S3 flow stores `storage_key`
   * instead and never exposes a public URL. Kept for back-compat with rows
   * created before private storage and for externally-hosted documents.
   */
  @Column({ nullable: true })
  file_url?: string;

  /** Private S3 object key (`<tenantId>/<docType>/<uuid>.<ext>`). Never a URL. */
  @Column({ nullable: true })
  storage_key?: string;

  /** Sanitised original filename, for display in the review UI. */
  @Column({ nullable: true })
  original_filename?: string;

  @Column({ nullable: true })
  mime_type?: string;

  /** File size in bytes (capped well below 2^31, so `int` is safe). */
  @Column({ type: 'int', nullable: true })
  size_bytes?: number;

  /** SHA-256 hex digest of the file content — drives same-type dedup. */
  @Column({ nullable: true })
  content_hash?: string;

  /** User id that performed the upload (audit trail). */
  @Column({ nullable: true })
  uploaded_by?: string;

  @Column({
    type: 'enum',
    enum: VerificationDocStatus,
    default: VerificationDocStatus.PENDING,
  })
  status!: VerificationDocStatus;

  @Column({ nullable: true })
  reviewed_by?: string;

  @Column({ nullable: true, type: 'text' })
  review_note?: string;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at!: Date;
}