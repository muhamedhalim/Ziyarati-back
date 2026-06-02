import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
} from 'typeorm';

import { Invoice } from './Invoice';
import { Tenant } from '../SaaS Core/Tenant';

@Entity('invoice_items')
export class InvoiceItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Invoice, {
    onDelete: 'CASCADE',
  })
  invoice!: Invoice;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column()
  description!: string;

  @Column({
    default: 1,
  })
  quantity!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  unit_price!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
  })
  total_price!: number;
}