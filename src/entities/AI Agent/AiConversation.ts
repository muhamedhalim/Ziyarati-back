import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Conversation } from '../Conversations/Conversation';
import { AiAgent } from './AiAgent';

@Entity('ai_conversations')
export class AiConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Conversation, { nullable: true })
  conversation?: Conversation;

  @ManyToOne(() => AiAgent, { nullable: true })
  agent?: AiAgent;

  @Column({ length: 20, default: 'ACTIVE' })
  status!: string;

  @CreateDateColumn()
  created_at!: Date;
}