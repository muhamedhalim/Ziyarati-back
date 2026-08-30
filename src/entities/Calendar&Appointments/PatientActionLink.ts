import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
  Check,
} from 'typeorm';

import { Appointment } from './Appointment';
import { Tenant } from '../SaaS-Core/Tenant';
import { PatientActionPurpose } from '../enums';

/**
 * Spec 014 (Clinic Platform Completion) — S1. The single credential
 * mechanism for every patient self-service action (cancel, reschedule,
 * accept a waitlist offer). Only a digest of the secret is ever stored — see
 * `PatientActionLinkService` (T009). Mirrors `RefreshToken.token_hash`,
 * deliberately NOT `PaymentLink.link_token`'s plaintext column.
 *
 * `waitlist_offer` has no FK constraint here: `waitlist_offers` does not
 * exist until T156 (Phase 13), which adds the constraint once its table
 * exists. This entity only declares the column.
 */
@Entity('patient_action_links')
@Index('IDX_patient_action_links_appointment_purpose', ['appointment', 'purpose'])
@Index('IDX_patient_action_links_expires_at', ['expires_at'])
@Check(
  'patient_action_links_waitlist_offer_required',
  `"purpose" <> 'WAITLIST_OFFER' OR "waitlist_offer" IS NOT NULL`,
)
export class PatientActionLink {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Appointment, {
    onDelete: 'CASCADE',
  })
  appointment!: Appointment;

  @Column({ type: 'varchar', length: 20 })
  purpose!: PatientActionPurpose;

  /** SHA-256 hex digest of the secret. Never the secret itself (R5). */
  @Column({ type: 'varchar', length: 64, unique: true })
  token_digest!: string;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumed_at?: Date | null;

  /** Set only when `purpose = WAITLIST_OFFER`. No FK yet — see class docblock. */
  @Column({ type: 'uuid', nullable: true })
  waitlist_offer?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
