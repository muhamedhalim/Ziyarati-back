import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';

/**
 * Long-term AI memory (Feature 5). A durable, reusable fact learned about a
 * patient/tenant (preference, favourite doctor, booking history, conversation
 * summary, FAQ topic …) — distinct from short-term session state.
 *
 * Following the KB pattern, the embedding lives in a pgvector SIDECAR
 * (`ai_memory_embeddings`) that TypeORM never manages, so `synchronize=true` in
 * dev cannot drop the `vector` column. This entity holds only the scalar fields.
 */
@Entity('ai_memories')
@Index(['tenant', 'customer_id'])
export class AiMemory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  /** Optional patient linkage (plain id — memory never joins the CRM table). */
  @Column({ type: 'uuid', nullable: true })
  customer_id?: string;

  /** Originating AI conversation, when the memory was derived from one. */
  @Column({ type: 'uuid', nullable: true })
  ai_conversation_id?: string;

  /** Memory kind, e.g. preference / summary / booking / faq / doctor / language. */
  @Column({ length: 32 })
  type!: string;

  @Column({ type: 'text' })
  content!: string;

  /** Higher = more important; used for ranking + retention (1..5). */
  @Column({ type: 'int', default: 1 })
  importance!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  /** Optional expiry — expired memories are never recalled and are purged. */
  @Column({ type: 'timestamptz', nullable: true })
  expires_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}
