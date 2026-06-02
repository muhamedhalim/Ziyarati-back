import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { PayoutStatus } from '../enums';

@Entity('settlements')
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    nullable: true,
  })
  branch?: Branch;

  @Column({
    type: 'date',
    nullable: true,
  })
  period_start?: Date;

  @Column({
    type: 'date',
    nullable: true,
  })
  period_end?: Date;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  gross_amount!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  fee_amount!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  net_amount!: number;

  @Column({
    default: 'USD',
    length: 3,
  })
  currency!: string;

  @Column({
    type: 'enum',
    enum: PayoutStatus,
    default: PayoutStatus.PENDING,
  })
  status!: PayoutStatus;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  paid_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;
}