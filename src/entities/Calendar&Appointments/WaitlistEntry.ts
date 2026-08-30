import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { Customer } from '../CRM/Customer';
import { StaffProfile } from '../Staff/StaffProfile';
import { Service } from '../Services/Service';
import { WaitlistState } from '../enums';

/**
 * Spec 014 (Clinic Platform Completion) — T155 (US9, data-model.md §1.8).
 * A patient's request to be offered a freed time for a service. See
 * `WaitlistOffer` for the concrete offers made against an entry, and
 * `enums.ts#WaitlistState` for the lifecycle.
 *
 * FR-W013's duplicate refusal is a DATABASE constraint
 * (`UQ_waitlist_entries_active_dup`, declared here AND in the migration —
 * same pattern as `Customer`'s soft-delete-aware uniqueness), not an
 * application-level pre-check: a pre-check races two concurrent creates for
 * the same (tenant, customer, service); only a partial unique index closes
 * that race.
 */
@Entity('waitlist_entries')
@Index('IDX_waitlist_entries_match', ['tenant', 'service', 'state'])
@Index('IDX_waitlist_entries_expiry', ['tenant', 'state', 'expires_at'])
@Index('IDX_waitlist_entries_dup_lookup', [
  'tenant',
  'customer',
  'service',
  'state',
])
@Index('UQ_waitlist_entries_active_dup', ['tenant', 'customer', 'service'], {
  unique: true,
  where: `"state" IN ('WAITING', 'OFFERED')`,
})
@Check(
  'waitlist_entries_window_order',
  `"window_end" IS NULL OR "window_start" IS NULL OR "window_end" > "window_start"`,
)
export class WaitlistEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Customer)
  customer!: Customer;

  @ManyToOne(() => Service)
  service!: Service;

  /** Optional practitioner preference — narrows matching, never widens it. */
  @ManyToOne(() => StaffProfile, { nullable: true })
  preferred_staff?: StaffProfile | null;

  /** Optional branch preference — narrows matching, never widens it. */
  @ManyToOne(() => Branch, { nullable: true })
  preferred_branch?: Branch | null;

  @Column({ type: 'timestamptz', nullable: true })
  window_start?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  window_end?: Date | null;

  /** Higher priority is matched first (FR-W007). */
  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: WaitlistState.WAITING,
  })
  state!: WaitlistState;

  /** Auto-expiry once the requested window has passed (FR-W004). */
  @Column({ type: 'timestamptz', nullable: true })
  expires_at?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
