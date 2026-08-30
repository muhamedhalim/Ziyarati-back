import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Customer } from '../CRM/Customer';
import { Appointment } from '../Calendar&Appointments/Appointment';
import { Branch } from '../SaaS-Core/Branch';
import { User } from '../Auth&RBAC/User';

/**
 * Spec 014 (Clinic Platform Completion) — T104 (US6, data-model.md §1.2,
 * FR-H001, FR-H003, FR-H005).
 *
 * A clinical visit. Survives cancellation of its `appointment` (FR-H005) —
 * never cascaded, never hidden; the timeline read marks entries whose
 * encounter's appointment was cancelled rather than excluding them.
 */
@Entity('clinical_encounters')
@Index('IDX_clinical_encounters_timeline', ['tenant', 'customer'])
@Index('IDX_clinical_encounters_appointment', ['tenant', 'appointment'])
export class ClinicalEncounter {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Customer)
  customer!: Customer;

  /** The visit it arose from, when there is one. Never cascade-deleted. */
  @ManyToOne(() => Appointment, { nullable: true })
  appointment?: Appointment | null;

  @ManyToOne(() => Branch, { nullable: true })
  branch?: Branch | null;

  /** Immutable — set server-side from the authenticated principal, never the request body. */
  @ManyToOne(() => User)
  author!: User;

  /** Clinical time, not row-creation time. */
  @Column({ type: 'timestamptz' })
  occurred_at!: Date;

  @Column({ type: 'text', nullable: true })
  summary?: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
