import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';
import { Customer } from '../CRM/Customer';
import { WhatsappAccount } from '../WhatsApp/WhatsappAccount';
import { User } from '../Auth&RBAC/User';

@Entity('conversations')
@Index(['tenant', 'customer'])
@Index(['tenant', 'status'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, { nullable: true })
  branch?: Branch;

  @ManyToOne(() => Customer, { nullable: true })
  customer?: Customer;

  @ManyToOne(() => WhatsappAccount, { nullable: true })
  whatsapp_account?: WhatsappAccount;

  @Column({ length: 20, default: 'BOT' })
  status!: string;

  @Column({ length: 20, nullable: true })
  type?: string;

  @ManyToOne(() => User, { nullable: true })
  assigned_to?: User;

  @Column({ type: 'timestamptz', nullable: true })
  last_message_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}