import {
  Entity,
  PrimaryColumn,
  ManyToOne,
} from 'typeorm';

import { Settlement } from './Settlement';
import { Payment } from './Payment';

@Entity('settlement_items')
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