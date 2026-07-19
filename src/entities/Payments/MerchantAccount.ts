import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/**
 * The clinic's FINANCIAL onboarding state — its merchant / sub-merchant
 * identity with the payment gateway (`merchant_accounts`, one row per tenant).
 *
 * Separate from `TenantApprovalStatus` on purpose: a clinic can be approved to
 * USE the platform while not yet eligible to RECEIVE money. Live payment
 * creation is gated on `status = APPROVED` (MerchantAccountService).
 *
 * Sensitive-data boundary: NO full bank data lives here. The IBAN is stored
 * masked (last 4 only) for display; the bank-account certificate itself goes
 * through the existing tenant verification documents (private R2 bucket).
 * `provider_recipient_id` is the gateway-issued split/payout recipient id —
 * an opaque reference, not a secret.
 */
@Entity('merchant_accounts')
export class MerchantAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => Tenant)
  @JoinColumn()
  tenant!: Tenant;

  /** MERCHANT_ACCOUNT_STATUS value (payments.constants). */
  @Column({ default: 'NOT_STARTED' })
  status!: string;

  /** Gateway this merchant identity belongs to (e.g. 'moyasar'). */
  @Column({ default: 'moyasar' })
  provider!: string;

  /**
   * Gateway-issued recipient / sub-merchant id (Moyasar split `recipient_id`).
   * Set by a platform admin once Moyasar issues it under the marketplace
   * contract. Required (with an APPROVED status) before splits are attached.
   */
  @Column({ nullable: true })
  provider_recipient_id?: string;

  @Column({ nullable: true })
  bank_name?: string;

  @Column({ nullable: true })
  beneficiary_name?: string;

  /** Masked IBAN for display (e.g. `SA** **** 1234`). Never the full IBAN. */
  @Column({ nullable: true })
  iban_masked?: string;

  /** Reviewer note shown to the clinic (e.g. what action is required). */
  @Column({ type: 'text', nullable: true })
  review_notes?: string;

  /**
   * Append-only audit trail of status transitions:
   * `[{ from, to, by, at, note }]`. Written by MerchantAccountService on every
   * transition — admin decisions on money eligibility are always attributable.
   */
  @Column({ type: 'jsonb', nullable: true })
  status_history?: Array<{
    from: string;
    to: string;
    by?: string;
    at: string;
    note?: string;
  }>;

  @Column({ type: 'timestamptz', nullable: true })
  submitted_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;
}
