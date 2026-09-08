import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { ServiceCategory } from './ServiceCategory';
import { ServicePrice } from './ServicePrice';
import { ServiceResource } from './ServiceResource';
import { Specialty } from '../System&Lookup/Specialty';

export enum PricingType {
  FIXED = 'FIXED',
  VARIABLE = 'VARIABLE',
}

@Entity('services')
@Index(['tenant', 'is_active'])
@Unique('UQ_services_tenant_public_slug', ['tenant', 'public_slug'])
export class Service {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: false,
  })
  tenant!: Tenant;

  /**
   * Marketplace BE-4 (T065) — stable clinic-scoped slug for the
   * `/clinics/[clinicSlug]/services/[serviceSlug]` route. Per-tenant unique
   * (not global) because the detail URL is already clinic-scoped. Assigned
   * once by `ServiceService.create()` or the backfill migration; a later
   * name change does NOT repoint it.
   */
  @Column({ type: 'varchar', length: 160 })
  public_slug!: string;

  @ManyToOne(() => ServiceCategory, (category) => category.services, {
    nullable: true,
  })
  category?: ServiceCategory;

  @Column()
  name!: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  description?: string;

  @Column()
  duration_minutes!: number;

  /** Marketplace BE-1: which specialty this service belongs to (at most one). Nullable so unclassified services keep working. */
  @ManyToOne(() => Specialty, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @Index()
  specialty?: Specialty | null;

  @Column({
    type: 'enum',
    enum: PricingType,
    default: PricingType.FIXED,
  })
  pricing_type!: PricingType;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
  })
  base_price?: number;

  @Column({
    default: true,
  })
  is_active!: boolean;

  @OneToMany(() => ServicePrice, (price) => price.service)
  prices!: ServicePrice[];

  @OneToMany(() => ServiceResource, (resource) => resource.service)
  resources!: ServiceResource[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}
