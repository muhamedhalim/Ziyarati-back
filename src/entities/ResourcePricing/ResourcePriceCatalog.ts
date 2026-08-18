import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';

/**
 * Admin-owned unit pricing for a sellable resource (Pricing Catalog plan,
 * Phase 2.1). `item_key` is the sellable-resource registry's own canonical
 * identifier (`sellable-resource.registry.ts`, Phase 1.1) — the registry
 * decides WHAT can be sold; this table decides at WHAT PRICE, and only for
 * items the registry has already declared `eligibility: 'sellable'`.
 *
 * `unit_size`/`unit_price_minor` are `bigint` (pg returns these as strings).
 * `is_active` is the rollout switch — no feature flag needed, matching
 * `FeatureCatalogService`'s own precedent. Created by migration
 * `1730043000000-ResourcePricingCatalog`.
 */
@Entity('resource_price_catalog')
export class ResourcePriceCatalog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 64, unique: true })
  item_key!: string;

  /** 'credit' | 'capacity' — mirrors SellableKind. */
  @Column({ length: 16 })
  kind!: string;

  @Column({ length: 32 })
  unit_label!: string;

  @Column({ type: 'bigint', default: 1 })
  unit_size!: string;

  @Column({ type: 'bigint', default: 0 })
  unit_price_minor!: string;

  @Column({ length: 3, default: 'SAR' })
  currency!: string;

  @Column({ default: 1 })
  min_quantity!: number;

  @Column({ nullable: true })
  max_quantity?: number;

  @Column({ default: false })
  is_active!: boolean;

  @Column({ default: 0 })
  sort_order!: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  updatedBy?: User;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
