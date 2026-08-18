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
import { User } from '../Auth&RBAC/User';
import { ResourcePriceCatalog } from './ResourcePriceCatalog';
import { Payment } from '../Payments/Payment';

/**
 * The commercial record AND the price snapshot (Pricing Catalog plan §17,
 * Phase 2.2). Once inserted, every one of `unit_price_minor`, `unit_size`,
 * `quantity`, `total_minor`, `delta_units`, `kind` and `currency` on THIS
 * ROW is the sole input to payment and entitlement — nothing downstream
 * re-reads `resource_price_catalog`. `catalogItem` is a `SET NULL`
 * provenance pointer only; a later price change, deactivation, or deletion
 * of the catalog row never alters an already-created purchase.
 *
 * No `ON DELETE` on `tenant` (bare FK, matches `resource_purchases`'
 * migration and `billing_upgrade_requests`' own precedent) — a financial
 * record physically blocks hard-deleting its tenant; the app never does
 * this anyway (verified: zero call sites).
 */
@Entity('resource_purchases')
export class ResourcePurchase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => Tenant, { nullable: false })
  tenant!: Tenant;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  purchasedBy?: User;

  @Column({ length: 255, nullable: true })
  purchased_by_email?: string;

  /** Provenance only — SET NULL, never re-read for price/entitlement (plan §17). */
  @ManyToOne(() => ResourcePriceCatalog, { nullable: true, onDelete: 'SET NULL' })
  catalogItem?: ResourcePriceCatalog;

  @Column({ length: 64 })
  item_key!: string;

  /** 'credit' | 'capacity' — snapshotted from the catalog item at purchase time. */
  @Column({ length: 16 })
  kind!: string;

  @Column({ length: 32 })
  unit_label!: string;

  @Column({ type: 'bigint' })
  unit_size!: string;

  @Column()
  quantity!: number;

  @Column({ type: 'bigint' })
  unit_price_minor!: string;

  @Column({ type: 'bigint' })
  total_minor!: string;

  @Column({ type: 'bigint' })
  delta_units!: string;

  @Column({ length: 3, default: 'SAR' })
  currency!: string;

  /** payment_processing | completed | payment_failed | refunded. */
  @Index()
  @Column({ length: 32, default: 'payment_processing' })
  status!: string;

  /** Client-generated UUID (plan §13) — unique per (tenant, key), no TTL. */
  @Column({ length: 64 })
  idempotency_key!: string;

  @ManyToOne(() => Payment, { nullable: true, onDelete: 'SET NULL' })
  payment?: Payment;

  @Column({ nullable: true })
  payment_reference?: string;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  failed_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  refunded_at?: Date;

  @Index()
  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
