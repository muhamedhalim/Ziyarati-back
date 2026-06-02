import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Unique,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { Service } from './Service';

@Entity('service_prices')
@Unique(['service', 'branch'])
export class ServicePrice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(
    () => Service,
    (service) => service.prices,
    {
      onDelete: 'CASCADE',
    },
  )
  service!: Service;

  @ManyToOne(() => Branch)
  branch!: Branch;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  price!: number;

  @Column({
    default: true,
  })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;
}