import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Payment } from './Payment';
import { User } from '../Auth&RBAC/User';

@Entity('refunds')
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Payment)
  payment!: Payment;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  amount!: number;

  @Column({
    type: 'text',
    nullable: true,
  })
  reason?: string;

  @Column({
    default: 'PENDING',
  })
  status!: string;

  @ManyToOne(() => User, {
    nullable: true,
  })
  processed_by?: User;

  @CreateDateColumn()
  created_at!: Date;
}