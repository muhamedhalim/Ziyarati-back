import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { InvoiceStatus } from '../enums';

@Entity('subscription_invoices')
export class SubscriptionInvoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  tenant_id!: string;

  @Column()
  subscription_id!: string;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  amount!: string;

  @Column({
    type: 'enum',
    enum: InvoiceStatus,
    default: InvoiceStatus.OPEN,
  })
  status!: InvoiceStatus;

  @Column({ type: 'timestamptz', nullable: true })
  issued_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at?: Date;
}