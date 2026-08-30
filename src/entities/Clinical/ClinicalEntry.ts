import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Customer } from '../CRM/Customer';
import { User } from '../Auth&RBAC/User';
import { ClinicalEncounter } from './ClinicalEncounter';
import { ClinicalEntryKind } from '../enums';

/**
 * Spec 014 (Clinic Platform Completion) — T104 (US6, data-model.md §1.3,
 * FR-H001–FR-H003, FR-H008, FR-H009, FR-H013, FR-H014).
 *
 * A single clinical entry (note/diagnosis/medication/allergy/vitals).
 * `customer` is denormalised from `encounter` so patient-level reads (e.g. a
 * standing allergy with no visit) need no join. `data` is validated by a
 * per-kind DTO at the service layer — this entity does not itself constrain
 * the jsonb shape. `version` (`@VersionColumn`) backs FR-H009's optimistic
 * lock, mirroring `Appointment.version`. Soft delete only (FR-H014) —
 * clinical content is never hard-deleted.
 */
@Entity('clinical_entries')
@Index('IDX_clinical_entries_timeline', ['tenant', 'customer', 'recorded_at'])
@Index('IDX_clinical_entries_kind', ['tenant', 'customer', 'kind'])
@Index('IDX_clinical_entries_encounter', ['tenant', 'encounter'])
export class ClinicalEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Customer)
  customer!: Customer;

  /** NULL for patient-level entries (e.g. a standing allergy with no visit). */
  @ManyToOne(() => ClinicalEncounter, { nullable: true })
  encounter?: ClinicalEncounter | null;

  @Column({ type: 'enum', enum: ClinicalEntryKind })
  kind!: ClinicalEntryKind;

  /** Kind-specific shape, validated by a per-kind DTO at the service layer. */
  @Column({ type: 'jsonb' })
  data!: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  recorded_at!: Date;

  /** Immutable — set server-side from the authenticated principal, never the request body. */
  @ManyToOne(() => User)
  author!: User;

  /** Optimistic lock (FR-H009) — a stale PATCH is rejected with 409. */
  @VersionColumn()
  version!: number;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
