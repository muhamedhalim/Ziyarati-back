import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Payment } from './Payment';
import { User } from '../Auth&RBAC/User';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

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
    transformer: decimalTransformer,
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

  /**
   * Caller-supplied idempotency key. A UNIQUE (tenant_id, idempotency_key)
   * partial index (created by PaymentsSchemaBootstrap / migration) makes refund
   * creation safe to retry — a replay returns the existing refund instead of
   * issuing a second gateway refund.
   */
  @Column({ nullable: true })
  idempotency_key?: string;

  /**
   * Gateway-side refund identifier. For refunds we initiate, this is the
   * provider's refund id; for refunds reconciled from a webhook (e.g. a refund
   * issued in the Moyasar dashboard), it is `recon:<eventId>`. A partial UNIQUE
   * index (created by PaymentsSchemaBootstrap / migration) makes reconciliation
   * idempotent at the DB level.
   */
  @Column({ nullable: true })
  gateway_refund_id?: string;

  @ManyToOne(() => User, {
    nullable: true,
  })
  processed_by?: User;

  @CreateDateColumn()
  created_at!: Date;
}