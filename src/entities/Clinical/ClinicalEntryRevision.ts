import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { ClinicalEntry } from './ClinicalEntry';

/**
 * Spec 014 (Clinic Platform Completion) — T104 (US6, data-model.md §1.4,
 * FR-H008).
 *
 * APPEND-ONLY — no update or delete path exists anywhere in the codebase.
 * `previous_data` is the entry's content BEFORE a correction, written in
 * the SAME transaction as the correction itself (T107) — a clinical edit
 * never destroys the prior content.
 */
@Entity('clinical_entry_revisions')
@Index('IDX_clinical_entry_revisions_entry', ['entry', 'created_at'])
export class ClinicalEntryRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => ClinicalEntry, { onDelete: 'CASCADE' })
  entry!: ClinicalEntry;

  /** The entry's content BEFORE this change. */
  @Column({ type: 'jsonb' })
  previous_data!: Record<string, unknown>;

  @ManyToOne(() => User)
  changed_by!: User;

  @CreateDateColumn()
  created_at!: Date;
}
