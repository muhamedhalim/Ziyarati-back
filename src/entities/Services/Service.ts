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
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { ServiceCategory } from './ServiceCategory';
import { ServicePrice } from './ServicePrice';
import { ServiceResource } from './ServiceResource';

export enum PricingType {
  FIXED = 'FIXED',
  VARIABLE = 'VARIABLE',
}

@Entity('services')
@Index(['tenant', 'is_active'])
export class Service {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: false,
  })
  tenant!: Tenant;

  @ManyToOne(
    () => ServiceCategory,
    (category) => category.services,
    {
      nullable: true,
    },
  )
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

  @OneToMany(
    () => ServicePrice,
    (price) => price.service,
  )
  prices!: ServicePrice[];

  @OneToMany(
    () => ServiceResource,
    (resource) => resource.service,
  )
  resources!: ServiceResource[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}