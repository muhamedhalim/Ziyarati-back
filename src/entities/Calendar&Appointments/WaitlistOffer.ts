import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { StaffProfile } from '../Staff/StaffProfile';
import { Appointment } from './Appointment';
import { WaitlistEntry } from './WaitlistEntry';
import { WaitlistOfferState } from '../enums';

/**
 * Spec 014 (Clinic Platform Completion) — T155 (US9, data-model.md §1.9).
 * A concrete freed slot offered to one waitlist entry.
 *
 * EXPLICITLY NOT A RESERVATION (FR-W009): no row in this table blocks a
 * slot from ordinary booking. The slot is held only by the real
 * `Appointment` created on acceptance, through the UNCHANGED
 * `AppointmentsService.create`, which applies the normal `assertBookable`
 * conflict prevention — see `WaitlistOfferService` for the concurrency-safe
 * accept/decline/expire/withdraw transitions this entity's `state` records.
 *
 * `UQ_waitlist_offers_entry_pending_slot` (declared here AND in the
 * migration) allows at most one LIVE (`PENDING`) offer per (entry, slot) —
 * it does not prevent the SAME slot being offered to several different
 * entries at once (bounded top-N matching, T157); accepting any one of them
 * withdraws every sibling (FR-W012).
 */
@Entity('waitlist_offers')
@Index('IDX_waitlist_offers_expiry', ['tenant', 'state', 'responds_by'])
@Index('IDX_waitlist_offers_entry_state', ['entry', 'state'])
@Index('UQ_waitlist_offers_entry_pending_slot', ['entry', 'start_at'], {
  unique: true,
  where: `"state" = 'PENDING'`,
})
export class WaitlistOffer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => WaitlistEntry, { onDelete: 'CASCADE' })
  entry!: WaitlistEntry;

  /** The concrete freed slot's branch. */
  @ManyToOne(() => Branch)
  branch!: Branch;

  /** The concrete freed slot's practitioner. */
  @ManyToOne(() => StaffProfile)
  staff!: StaffProfile;

  @Column({ type: 'timestamptz' })
  start_at!: Date;

  @Column({ type: 'timestamptz' })
  end_at!: Date;

  @Column({
    type: 'varchar',
    length: 20,
    default: WaitlistOfferState.PENDING,
  })
  state!: WaitlistOfferState;

  /** Response deadline (FR-W008) — past this, the offer expires and the time may be offered onward. */
  @Column({ type: 'timestamptz' })
  responds_by!: Date;

  /** Set only on acceptance. */
  @ManyToOne(() => Appointment, { nullable: true })
  appointment?: Appointment | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
