import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Payment } from './Payment';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Payment)
  payment!: Payment;

  @Column({
    nullable: true,
  })
  gateway_transaction_id?: string;

  @Column()
  type!: string;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  amount!: number;

  @Column()
  status!: string;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  raw_response?: Record<string, any>;

  @CreateDateColumn()
  created_at!: Date;
}