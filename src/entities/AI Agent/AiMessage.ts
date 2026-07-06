import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

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

  /**
   * Set ONLY when this `role: 'assistant'` row was actually authored by a human
   * agent during a live handover (see `HandoverChatService.sendAgentReply`) —
   * never by the model. The AI's history-loading code (`AiExecutionService`)
   * treats every row identically regardless of this column, so a returned-to-AI
   * conversation sees the human's replies as prior context with zero special
   * handling — the timeline/UI use this column to attribute authorship.
   */
  @Column({ nullable: true })
  agent_user_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}