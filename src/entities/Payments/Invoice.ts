import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  DeleteDateColumn,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Appointment } from '../Calendar&Appointments/Appointment';
import { Customer } from '../CRM/Customer';
import { InvoiceStatus } from '../enums';

@Entity('invoices')
@Unique(['tenant', 'invoice_number'])
export class Invoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Appointment, {
    nullable: true,
  })
  appointment?: Appointment;

  @ManyToOne(() => Customer, {
    nullable: true,
  })
  customer?: Customer;

  @Column()
  invoice_number!: string;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
  })
  total_amount!: number;

  @Column({
    type: 'enum',
    enum: InvoiceStatus,
    default: InvoiceStatus.DRAFT,
  })
  status!: InvoiceStatus;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  issued_at?: Date;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  paid_at?: Date;

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}