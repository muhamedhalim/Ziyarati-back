import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { Appointment } from '../Calendar&Appointments/Appointment';
import { Customer } from '../CRM/Customer';
import { PaymentStatus, SettlementStatus } from '../enums';

@Entity('payments')
@Index(['tenant', 'status'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    nullable: true,
  })
  branch?: Branch;

  @ManyToOne(() => Appointment, {
    nullable: true,
  })
  appointment?: Appointment;

  @ManyToOne(() => Customer, {
    nullable: true,
  })
  customer?: Customer;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  amount!: number;

  @Column({
    default: 'USD',
  })
  currency!: string;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status!: PaymentStatus;

  @Column({
    nullable: true,
  })
  gateway?: string;

  @Column({
    nullable: true,
  })
  gateway_payment_id?: string;

  @Column({
    type: 'enum',
    enum: SettlementStatus,
    default: SettlementStatus.UNSETTLED,
  })
  settlement_status!: SettlementStatus;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  paid_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}