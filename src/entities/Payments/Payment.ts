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

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { Appointment } from '../Calendar&Appointments/Appointment';
import { Customer } from '../CRM/Customer';
import { PaymentStatus, SettlementStatus } from '../enums';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

@Entity('payments')
@Index(['tenant', 'status'])
@Index(['paid_at'])
@Index(['appointment'])
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
  unique: true,
})
gateway_payment_id?: string;

@Column({
  nullable: true,
  unique: true,
})
idempotency_key?: string;

  @Column({
    type: 'enum',
    enum: SettlementStatus,
    default: SettlementStatus.UNSETTLED,
  })
  settlement_status!: SettlementStatus;

  // ── Persisted financial breakdown (frozen at the moment of payment) ───────
  // Gross is `amount`. Fees may change over time, so we store the figures used
  // at capture rather than recomputing later. Populated when the gateway/config
  // provide them; default 0 keeps `net = gross` until fee data is available.

  /** Gateway processing fee in major units (e.g. Moyasar `data.fee`/100). */
  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: decimalTransformer,
  })
  gateway_fee!: number;

  /** Platform/marketplace commission retained by the platform. */
  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: decimalTransformer,
  })
  platform_fee!: number;

  /** Amount owed to the clinic: gross − gateway_fee − platform_fee. */
  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  net_amount?: number;

  /** Payment instrument as reported by the gateway (e.g. `creditcard`, `applepay`). */
  @Column({ nullable: true })
  payment_method?: string;

  /** Gateway merchant identifiers (marketplace split context), when provided. */
  @Column({ nullable: true })
  merchant_id?: string;

  @Column({ nullable: true })
  sub_merchant_id?: string;

  /** Cumulative successfully-refunded amount (mirrors the Refund ledger). */
  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: decimalTransformer,
  })
  refunded_amount!: number;

  /** NONE | PARTIAL | FULL — denormalised refund state for fast filtering. */
  @Column({ nullable: true })
  refund_status?: string;

  @Column({ type: 'timestamptz', nullable: true })
  refunded_at?: Date;

  /** Gateway failure reason captured on a failed payment. */
  @Column({ type: 'text', nullable: true })
  failure_reason?: string;

  /** Free-form gateway metadata snapshot (never trusted for money math). */
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

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