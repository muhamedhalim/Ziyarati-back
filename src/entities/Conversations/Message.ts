import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Conversation } from './Conversation';
import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';
import { Customer } from '../CRM/Customer';

@Entity('messages')
@Index(['conversation', 'created_at'])
@Index(['tenant', 'created_at'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Conversation, {
    onDelete: 'CASCADE',
  })
  conversation!: Conversation;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ length: 20 })
  sender_type!: 'CUSTOMER' | 'AGENT' | 'BOT' | 'SYSTEM';

  @ManyToOne(() => User, { nullable: true })
  sender_user?: User;

  @ManyToOne(() => Customer, { nullable: true })
  sender_customer?: Customer;

  @Column({ type: 'text', nullable: true })
  content?: string;

  @Column({ length: 20, default: 'text' })
  message_type!: string;

  @Column({ length: 255, nullable: true })
  wa_message_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}