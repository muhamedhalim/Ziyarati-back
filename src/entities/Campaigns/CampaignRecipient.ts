import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Unique,
  Index,
} from 'typeorm';

import { Campaign } from './Campaign';
import { Customer } from '../CRM/Customer';
import { RecipientStatus } from '../enums';

@Entity('campaign_recipients')
@Unique(['campaign', 'customer'])
@Index(['campaign', 'status'])
export class CampaignRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Campaign, {
    onDelete: 'CASCADE',
  })
  campaign!: Campaign;

  @ManyToOne(() => Customer)
  customer!: Customer;

  @Column({
    type: 'enum',
    enum: RecipientStatus,
    default: RecipientStatus.QUEUED,
  })
  status!: RecipientStatus;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  sent_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}