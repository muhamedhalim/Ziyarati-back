import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { IntegrationImportJob } from './IntegrationImportJob';

/**
 * A single record's SAFE outcome within an import job (Phase 4). This is the
 * tenant-visible per-item history: it stores ONLY the external id, the outcome,
 * the resulting internal id, the changed field NAMES, and a truncated safe
 * error — never the record's field VALUES, secrets, medical notes or payment
 * data. Item `status` (`pending` → `done`/`failed`) supports retry of only the
 * failed items of a job.
 */
@Entity('integration_import_items')
@Index('IX_integration_import_items_job', ['job'])
export class IntegrationImportItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => IntegrationImportJob, { nullable: false, onDelete: 'CASCADE' })
  job!: IntegrationImportJob;

  /** The external system's own id for the record (safe identifier, not content). */
  @Column({ type: 'varchar', length: 255 })
  external_id!: string;

  /** created | updated | linked | skipped | conflicted | failed */
  @Column({ type: 'varchar', length: 20 })
  outcome!: string;

  /** pending | done | failed — drives failed-item retry. */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  @Column({ type: 'uuid', nullable: true })
  internal_resource_id?: string | null;

  /** Names only of the fields that changed — never their values. */
  @Column({ type: 'jsonb', nullable: true })
  changed_fields?: string[] | null;

  /** Truncated, safe error message (never secrets / full records). */
  @Column({ type: 'text', nullable: true })
  error?: string | null;

  @CreateDateColumn()
  created_at!: Date;
}
