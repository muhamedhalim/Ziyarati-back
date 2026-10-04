import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { PayoutStatus } from '../enums';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

// A payout the gateway made is mirrored at most once (re-importing it is a no-op).
@Index('UQ_settlements_provider_payout', ['provider', 'provider_payout_id'], {
  unique: true,
  where: '"provider_payout_id" IS NOT NULL',
})
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
    transformer: decimalTransformer,
  })
  gross_amount!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: decimalTransformer,
  })
  fee_amount!: number;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    default: 0,
    transformer: decimalTransformer,
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

  /**
   * INTERNAL = a batch ZiyaraTech built from payments it collected; PROVIDER = a
   * MIRROR of a payout the gateway itself made to the clinic's merchant (Tap
   * Platform). A mirror is read-only: ZiyaraTech moves no money for it.
   */
  @Column({ type: 'varchar', length: 16, default: 'INTERNAL' })
  source!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  provider?: string | null;

  /** The gateway's payout id (Tap `payout_…`). Unique per provider. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  provider_payout_id?: string | null;

  /** The bank's reference for the transfer, as the gateway reports it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  bank_reference?: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at?: Date;
}