import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Appointment } from '../Calendar&Appointments/Appointment';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

@Entity('payment_links')
export class PaymentLink {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Appointment, {
    nullable: true,
  })
  appointment?: Appointment;

  @Column({
    type: 'decimal',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  amount!: number;

  @Column({
    unique: true,
  })
  link_token!: string;

  @Column({
    default: 'ACTIVE',
  })
  status!: string;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  expires_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}