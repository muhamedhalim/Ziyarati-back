import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';

@Entity('payment_gateways')
export class PaymentGateway {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @Column()
  gateway_name!: string;

  @Column({
    default: true,
  })
  is_active!: boolean;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  config?: Record<string, any>;

  @CreateDateColumn()
  created_at!: Date;
}