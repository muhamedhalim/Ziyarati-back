import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';

/**
 * A WhatsApp sending identity owned by ONE tenant.
 *
 * Multi-tenant Tech Provider model: ZiyaraTech owns a single Meta App; each
 * clinic connects its OWN Meta Business + WABA + phone number through Embedded
 * Signup. Every row here is therefore per-tenant — there is no number shared
 * across clinics (see WhatsappAccountResolver).
 *
 * SCOPE: `branch` is NULLABLE.
 *   - `branch = NULL` → a TENANT-level number, usable by any branch.
 *   - `branch = X`    → a BRANCH-level number, preferred for that branch.
 * A tenant may hold several of each; `is_default` (not row age) decides which
 * one is used when nothing more specific applies.
 *
 * `phone_number_id` is UNIQUE among live rows: inbound Meta webhooks identify
 * the owning tenant by nothing but `metadata.phone_number_id`, so two tenants
 * claiming one number would let one clinic receive another's patient messages.
 * PARTIAL so disconnecting (soft-deleting) frees the number for reconnection and
 * unconfigured rows (NULL) don't collide. Declared here AND in migrations so
 * `synchronize` (dev) and migrations (prod) converge instead of fighting.
 *
 * Note there is deliberately no longer a UNIQUE(branch, mode): that capped each
 * branch at one number per mode and made "multiple numbers per tenant"
 * unrepresentable. Uniqueness now lives where it is actually a business
 * invariant — on the Meta phone number itself.
 */
@Entity('whatsapp_accounts')
@Index('UQ_whatsapp_account_phone_number_id_live', ['phone_number_id'], {
  unique: true,
  where: '"deleted_at" IS NULL AND "phone_number_id" IS NOT NULL',
})
// At most ONE default per tenant. Declared here as well as in the migration so
// `synchronize` (dev) does not drop what the migration (prod) created — without
// this the resolver could find two defaults and be back to guessing.
@Index('UQ_whatsapp_account_one_default_per_tenant', ['tenant'], {
  unique: true,
  where: '"is_default" = true AND "deleted_at" IS NULL',
})
// Hot path: the resolver selects a tenant's usable accounts on every send.
@Index('IDX_whatsapp_account_tenant_active', ['tenant', 'is_active'])
export class WhatsappAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  /** NULL = a tenant-level number available to every branch. */
  @ManyToOne(() => Branch, { nullable: true })
  @JoinColumn({ name: 'branch_id' })
  branch?: Branch | null;

  /** 'PLATFORM' | 'CUSTOM' — see WHATSAPP_ACCOUNT_MODE. */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'CUSTOM',
  })
  mode!: string;

  /** Delivery backend — see WHATSAPP_PROVIDER. Only META_CLOUD is implemented. */
  @Column({
    type: 'varchar',
    length: 30,
    default: 'META_CLOUD',
  })
  provider!: string;

  /**
   * The clinic's Meta Business (portfolio) id that owns the WABA. Captured at
   * Embedded Signup for support/diagnostics and to detect a clinic reconnecting
   * a WABA under a different business.
   */
  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  meta_business_id?: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  phone_number_id?: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  waba_id?: string;

  /** Human-readable number as Meta displays it, e.g. `+966 50 123 4567`. */
  @Column({
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  display_phone_number?: string;

  /** Meta-verified business display name shown to recipients. */
  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  verified_name?: string;

  /**
   * Connection lifecycle — see WHATSAPP_CONNECTION_STATUS. Deliberately
   * separate from `is_active`: this reflects what META thinks of the
   * connection, `is_active` reflects what the OPERATOR wants. Only a
   * CONNECTED + active account can send.
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: 'PENDING',
  })
  connection_status!: string;

  /**
   * Meta access token, ENCRYPTED at rest (AES-256-GCM, `enc:v1:` envelope —
   * see EncryptionService). Written encrypted by the onboarding/account
   * services and decrypted ONLY by WhatsappAccountResolver for the delivery
   * adapter; never returned by the API (reads expose `hasCredentials`) and
   * never logged. Ciphertext is ~2x the plaintext length, hence `text`.
   */
  @Column({
    type: 'text',
    nullable: true,
  })
  access_token?: string;

  /**
   * Expiry of `access_token`. Embedded Signup yields a long-lived System User
   * token, which Meta may return without an expiry — NULL therefore means
   * "does not expire", not "unknown".
   */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  token_expires_at?: Date;

  /** When Embedded Signup completed successfully. */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  connected_at?: Date;

  /** Last successful template sync from Meta. */
  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  last_synced_at?: Date;

  /**
   * The tenant's preferred number when no branch-specific one applies. At most
   * one live default per tenant (partial unique index in the migration) — the
   * explicit answer to "which number?", replacing an implicit oldest-row guess.
   */
  @Column({ default: false })
  is_default!: boolean;

  /** Operator on/off switch. See `connection_status` for Meta's view. */
  @Column({
    default: true,
  })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
