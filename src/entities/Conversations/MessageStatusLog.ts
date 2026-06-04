import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Message } from './Message';
import { Tenant } from '../SaaS-Core/Tenant';

@Entity('message_status_logs')
export class MessageStatusLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Message, {
    onDelete: 'CASCADE',
  })
  message!: Message;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ length: 20 })
  status!: string; // SENT / DELIVERED / READ / FAILED

  @CreateDateColumn()
  created_at!: Date;
}