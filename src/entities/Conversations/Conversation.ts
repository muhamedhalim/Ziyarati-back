import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
  Check,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';
import { Customer } from '../CRM/Customer';
import { WhatsappAccount } from '../WhatsApp/WhatsappAccount';
import { User } from '../Auth&RBAC/User';

@Entity('conversations')
@Index(['tenant', 'customer'])
@Index(['tenant', 'status'])
@Check(
  'CHK_conversations_ai_mode',
  `"ai_mode" IN ('DEFAULT','ENABLED','DISABLED')`,
)
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

  /**
   * Live Agent Handover ownership. Who is currently responsible for replying:
   * the AI (default) or a human agent. This is the single flag the WhatsApp/
   * widget inbound path checks to decide whether the AI is allowed to answer —
   * it is NOT a duplicate of `AiConversation.status`, it drives the human-facing
   * timeline/inbox, while `AiConversation.status` (HANDED_OVER) is what actually
   * gates `AiExecutionService`. Both are flipped together by HandoverRequestService.
   */
  @Column({ length: 10, default: 'AI' })
  owner_type!: string;

  @Column({ type: 'timestamptz', nullable: true })
  assigned_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  released_at?: Date;

  @Column({ type: 'text', nullable: true })
  handover_reason?: string;

  @Column({ type: 'text', nullable: true })
  handover_notes?: string;

  /** Incremented on every transfer — powers the Inbox's "Transferred" tab. */
  @Column({ default: 0 })
  transfer_count!: number;

  /** Last time the currently-assigned agent viewed this conversation (unread tracking). */
  @Column({ type: 'timestamptz', nullable: true })
  agent_last_read_at?: Date;

  /**
   * Conversation-level WhatsApp AI override, set by staff from the inbox:
   * `DEFAULT` (follow the clinic setting), `ENABLED`, or `DISABLED` (paused —
   * the AI neither answers nor is called, but the thread keeps receiving
   * messages). Read in exactly one place, `WhatsappAiPolicyService`. This is NOT
   * the human-takeover state (`owner_type`); that is a different fact.
   */
  @Column({ type: 'varchar', length: 16, default: 'DEFAULT' })
  ai_mode!: string;

  /**
   * Automatic human takeover: while this instant is in the future the AI stays
   * silent because a staff member replied recently. A timestamp compared at
   * decision time, never a timer — it expires by itself, so there is nothing to
   * schedule, clean up or get wrong under retries. `NULL` = no takeover.
   */
  @Column({ type: 'timestamptz', nullable: true })
  ai_paused_until?: Date | null;

  /** When `ai_mode` last changed — shown in the conversation's AI status. */
  @Column({ type: 'timestamptz', nullable: true })
  ai_mode_changed_at?: Date | null;

  /** Who last changed `ai_mode`. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'ai_mode_changed_by_id' })
  ai_mode_changed_by?: User | null;

  @CreateDateColumn()
  created_at!: Date;
}