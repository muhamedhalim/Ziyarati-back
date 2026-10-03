import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Tenant } from './Tenant';

/** `tenant_payment_methods.status` (free-form varchar, like the other status-ish columns). */
export const PAYMENT_METHOD_STATUS = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const;

/**
 * A clinic's saved card, as the PAYMENT GATEWAY knows it — never the card.
 *
 * What is stored is exactly the three opaque ids a merchant-initiated charge
 * needs (`provider_customer_id`, `provider_card_id`,
 * `provider_payment_agreement_id`) plus display facts the gateway already
 * returns in the clear (brand, scheme, last four). There is NO PAN, CVV or
 * expiry anywhere in this table, and none of it can be used without ZiyaraTech's
 * own gateway secret key.
 *
 * At most one ACTIVE default per tenant (partial unique index below — also
 * declared here, so a metadata-built schema carries it). A card id is unique
 * across tenants: one physical saved card can never be attached to two clinics.
 */
@Entity('tenant_payment_methods')
@Index('UQ_tenant_payment_method_card', ['provider_card_id'], { unique: true })
@Index('UQ_tenant_payment_method_default', ['tenant_id'], {
  unique: true,
  where: `"is_default" = true AND "status" = 'ACTIVE'`,
})
export class TenantPaymentMethod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenant_id',
    foreignKeyConstraintName: 'FK_tenant_payment_methods_tenant',
  })
  tenant?: Tenant;

  /** Gateway name (`tap`). */
  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @Column({ type: 'varchar', length: 64 })
  provider_customer_id!: string;

  @Column({ type: 'varchar', length: 64 })
  provider_card_id!: string;

  /** The gateway's stored consent for merchant-initiated charges on this card. */
  @Column({ type: 'varchar', length: 96 })
  provider_payment_agreement_id!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  brand?: string | null;

  /** Card scheme (VISA, MASTERCARD, MADA, …). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  scheme?: string | null;

  @Column({ type: 'char', length: 4, nullable: true })
  last_four?: string | null;

  /**
   * Whether renewals may charge this card without the clinic present. FALSE
   * for a scheme the gateway cannot charge that way (e.g. KNET/Benefit) — the
   * renewal then falls back to asking the clinic to pay through checkout.
   */
  @Column({ type: 'boolean', default: true })
  recurring_capable!: boolean;

  @Column({ type: 'boolean', default: false })
  is_default!: boolean;

  @Column({
    type: 'varchar',
    length: 16,
    default: PAYMENT_METHOD_STATUS.ACTIVE,
  })
  status!: string;

  /** The invoice whose checkout saved this card (audit only). */
  @Column({ type: 'uuid', nullable: true })
  source_invoice_id?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at?: Date | null;
}
