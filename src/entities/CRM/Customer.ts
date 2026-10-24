import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { CustomerProfile } from '../CRM/CustomerProfile';
import { CustomerAddress } from '../CRM/CustomerAddress';
import { CustomerNote } from '../CRM/CustomerNote';
import { CustomerFile } from '../CRM/CustomerFile';
import { CustomerTagRelation } from '../CRM/CustomerTagRelation';

@Entity('customers')
// `phone` is deliberately NOT unique — multiple customers (e.g. a shared
// household/family line, a walk-in without their own number) may legitimately
// share one. This is a plain lookup index only, for search and booking-match
// performance. `national_id` is the sole hard identity key (see below). See
// migration CrmCustomerSoftDeleteAwareUniqueness1730059000000.
@Index(['tenant', 'phone'])
// FND-040/M-01: tenant-scoped, matching the sibling phone index above — was
// UNIQUE (email) globally (migration CustomerTenantScopedEmail1730019000000).
// Scoped to LIVE rows only (`deleted_at IS NULL`) — a soft-deleted customer's
// email must not permanently block re-creating a customer with that email;
// see migration CrmCustomerSoftDeleteAwareUniqueness1730059000000.
@Index(['tenant', 'email'], { unique: true, where: '"deleted_at" IS NULL' })
// `national_id` is OPTIONAL (not every clinic collects it), so this is a
// partial unique index — only enforced once a value is actually set, and
// (like email above) only against LIVE rows, so deleting a customer frees
// their national_id up for reuse. See migrations CustomerNationalId1730053000000
// and CrmCustomerSoftDeleteAwareUniqueness1730059000000.
@Index(['tenant', 'national_id'], {
  unique: true,
  where: '"national_id" IS NOT NULL AND "deleted_at" IS NULL',
})
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ nullable: true })
  full_name?: string;

  @Column({ length: 20 })
  phone!: string;

  @Column({ nullable: true })
  whatsapp_id?: string;

  @Column({ nullable: true })
  whatsapp_name?: string;

  // OPTIONAL — nullable at the DB level (migration CustomerEmailNullable1730112000000).
  // Uniqueness is expressed by the tenant-scoped class-level @Index above, not
  // `unique: true` here (that would be a GLOBAL constraint, which is exactly
  // the defect FND-040 fixes). Postgres treats NULLs as distinct in unique
  // indexes, so any number of email-less customers may coexist per tenant.
  @Column({ type: 'varchar', length: 255, nullable: true })
  email?: string | null;

  @Column({ nullable: true })
  gender?: string;

  @Column({ type: 'date', nullable: true })
  date_of_birth?: Date;

  /**
   * Client ID/identity number, captured directly in the New/Edit Customer
   * form. Optional (nullable), unique per tenant when provided — see the
   * partial index above. Age is deliberately NOT stored anywhere: it is
   * always derived from `date_of_birth` at read time, so it never drifts.
   */
  @Column({ type: 'varchar', length: 50, nullable: true })
  national_id?: string | null;

  @Column({ nullable: true })
  source?: string;

  @Column({ default: false })
  marketing_opt_in!: boolean;

  /** When `marketing_opt_in` last became true. NULL = legacy row, provenance unknown. */
  @Column({ type: 'timestamptz', nullable: true })
  marketing_opt_in_at?: Date | null;

  /** How consent was given (`staff`, `import`, …). NULL = legacy, unknown. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  marketing_opt_in_source?: string | null;

  /**
   * FND-024/M-05: when an inbound opt-out (e.g. "STOP") was detected. `NULL`
   * means never opted out — no backfill on migration. Additive to, not a
   * replacement for, `marketing_opt_in`: this records WHEN/HOW, which the
   * boolean alone cannot express.
   */
  @Column({ type: 'timestamptz', nullable: true })
  opted_out_at?: Date | null;

  /** How the opt-out was registered (e.g. `inbound_keyword`, `manual`) — for audit. NULL until opted_out_at is set. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  opt_out_source?: string | null;

  @Column({ default: true })
  is_active!: boolean;

  /**
   * M-09/CAP-I18N: persisted locale preference for recipient-locale
   * notifications (FR-H014/FR-H015). `NULL` means "no explicit choice
   * recorded, fall back to `DEFAULT_LOCALE`" — never backfilled, mirrors
   * `User.preferred_locale`'s (M-08) exact semantics.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  preferred_locale?: string | null;

  /**
   * Chronic-disease intake, captured directly in the New/Edit Customer form
   * (distinct from the free-text clinical fields on `CustomerProfile`).
   * `chronic_diseases` is required when this is true and forced to `null`
   * when false — enforced authoritatively in `CustomerService`, not just
   * the DTO — so the two columns can never disagree.
   */
  @Column({ default: false })
  has_chronic_diseases!: boolean;

  @Column({ type: 'text', nullable: true })
  chronic_diseases?: string | null;

  /**
   * Tri-state: `NULL` = never asked, `true`/`false` = a confirmed answer.
   * Captured directly (New/Edit Customer form, or the AI booking flow) —
   * mirrors `has_chronic_diseases` in placement, not the separate clinical
   * `CustomerProfile` record. Drives the AI booking flow's payment-link
   * decision (see `AiToolDispatchService.bookAppointment`) and lets a
   * returning patient's on-file answer be confirmed instead of re-asked.
   */
  @Column({ type: 'boolean', nullable: true })
  has_health_insurance?: boolean | null;

  /**
   * Patient-level exclusion from the WhatsApp AI. When `true` the AI never
   * answers this patient — on any conversation, and for any number linked to
   * them — while their messages are still received, stored and visible to staff.
   * Read in exactly one place, `WhatsappAiPolicyService`; written only by the
   * dedicated `PATCH /crm/customers/:id/ai-replies` route, never by the generic
   * customer update.
   */
  @Column({ default: false })
  ai_replies_disabled!: boolean;

  /** When the exclusion was last switched on; `NULL` when not excluded. */
  @Column({ type: 'timestamptz', nullable: true })
  ai_replies_disabled_at?: Date | null;

  @OneToOne(() => CustomerProfile, (profile) => profile.customer)
  profile?: CustomerProfile;

  @OneToMany(() => CustomerAddress, (address) => address.customer)
  addresses!: CustomerAddress[];

  @OneToMany(() => CustomerNote, (note) => note.customer)
  notes!: CustomerNote[];

  @OneToMany(() => CustomerFile, (file) => file.customer)
  files!: CustomerFile[];

  @OneToMany(() => CustomerTagRelation, (relation) => relation.customer)
  tags!: CustomerTagRelation[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
