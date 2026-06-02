import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';

@Entity('ai_messages')
@Index(['ai_conversation_id', 'created_at'])
export class AiMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  ai_conversation_id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @Column({ length: 20 })
  role!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ default: 0 })
  tokens_used!: number;

  @CreateDateColumn()
  created_at!: Date;
}