import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Customer } from '../CRM/Customer';
import { User } from '../Auth&RBAC/User';
import { ClinicalEntry } from './ClinicalEntry';

/**
 * Spec 014 (Clinic Platform Completion) — T104 (US6, data-model.md §1.5,
 * FR-H011, FR-H012).
 *
 * APPEND-ONLY. Deliberately separate from `audit_logs` — clinical reads are
 * high-volume and must NEVER be surfaced by the Audit UI (FR-H012, FR-U008).
 */
@Entity('clinical_access_logs')
@Index('IDX_clinical_access_logs_customer', [
  'tenant',
  'customer',
  'created_at',
])
export class ClinicalAccessLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  /** Whose record was read. */
  @ManyToOne(() => Customer)
  customer!: Customer;

  /** Who read it. */
  @ManyToOne(() => User)
  user!: User;

  /** e.g. `timeline`, `summary`, `entry`. */
  @Column({ type: 'varchar', length: 40 })
  scope!: string;

  /** Set when a single entry was read. */
  @ManyToOne(() => ClinicalEntry, { nullable: true })
  entry?: ClinicalEntry | null;

  @CreateDateColumn()
  created_at!: Date;
}
