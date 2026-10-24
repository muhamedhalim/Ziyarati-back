import {
  Entity,
  Index,
  PrimaryColumn,
  ManyToOne,
} from 'typeorm';

import { Settlement } from './Settlement';
import { Payment } from './Payment';

@Entity('settlement_items')
// A payment is paid out in at most one settlement (migration FinancialIntegrityChecks).
@Index('UQ_settlement_items_payment', ['payment_id'], { unique: true })
export class SettlementItem {
  @PrimaryColumn('uuid')
  settlement_id!: string;

  @PrimaryColumn('uuid')
  payment_id!: string;

  @ManyToOne(
    () => Settlement,
    {
      onDelete: 'CASCADE',
    },
  )
  settlement!: Settlement;

  @ManyToOne(() => Payment)
  payment!: Payment;
}