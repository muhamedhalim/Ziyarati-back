import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
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

  /**
   * Origin channel of the session (WEBSITE / DASHBOARD / WHATSAPP / API / …).
   * Lets one AI conversation model serve every channel (Phase 3). Added by
   * migration 1730002200000.
   */
  @Column({ length: 20, default: 'API' })
  channel!: string;

  /** Preferred conversation language (BCP-47-ish, e.g. `en`, `ar`). */
  @Column({ length: 12, nullable: true })
  language?: string;

  /**
   * ACTIVE conversation state (Phase 5) — selected clinic/branch/doctor, current
   * intent, current booking draft, auth state, working context. This is short-term
   * session state, NOT long-term memory. Stored inline (jsonb) so a turn reads it
   * without an extra table; merged via ConversationSessionService.
   */
  @Column({ type: 'jsonb', nullable: true })
  session?: Record<string, unknown>;

  @CreateDateColumn()
  created_at!: Date;
}