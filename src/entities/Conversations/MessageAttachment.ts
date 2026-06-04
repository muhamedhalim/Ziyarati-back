import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Message } from './Message';
import { Tenant } from '../SaaS-Core/Tenant';

@Entity('message_attachments')
export class MessageAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Message, {
    onDelete: 'CASCADE',
  })
  message!: Message;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ type: 'text', nullable: true })
  file_url?: string;

  @Column({ length: 50, nullable: true })
  file_type?: string;

  @Column({ length: 255, nullable: true })
  file_name?: string;

  @CreateDateColumn()
  created_at!: Date;
}