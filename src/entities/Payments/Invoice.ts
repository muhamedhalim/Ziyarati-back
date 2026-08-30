import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  DeleteDateColumn,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Appointment } from '../Calendar&Appointments/Appointment';
import { Customer } from '../CRM/Customer';
import { InvoiceStatus } from '../enums';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

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

  /**
   * FR-I005 (spec 014, T092/T093) — snapshotted from `tenant_settings.currency`
   * at CREATE time, never re-read from the live setting afterward. A later
   * currency change must not rewrite an already-issued invoice's currency.
   */
  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: decimalTransformer,
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

  // ── T095/T096 (spec 014, US12) — document render tracking ──────────────

  /** Current rendered PDF's private, tenant-prefixed storage key (FR-I012). Overwritten each render. */
  @Column({ type: 'varchar', nullable: true })
  document_key?: string | null;

  /** Bumped by whatever should trigger a (re-)render: `finalize()`, the regenerate route. */
  @Column({ type: 'int', default: 0 })
  document_version!: number;

  /** The version `document_key` was actually rendered for. Behind `document_version` = pending. */
  @Column({ type: 'int', nullable: true })
  document_rendered_version?: number | null;
}
