import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { AiAgent } from './AiAgent';
import { Tenant } from '../SaaS-Core/Tenant';

@Entity('ai_knowledge_bases')
@Index(['tenant', 'agent'])
// The migration uses an equivalent COALESCE(source_id, nil-uuid) expression so
// NULL/manual sources are also race-safe under PostgreSQL uniqueness rules.
@Index(['tenant', 'agent', 'source_id', 'content_hash'], { unique: true })
export class AiKnowledgeBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => AiAgent, { onDelete: 'CASCADE' })
  agent!: AiAgent;

  @Column({ type: 'text' })
  content!: string;

  @Column({ length: 64 })
  content_hash!: string;

  @Column({ length: 80, default: 'v1' })
  embedding_version!: string;

  // @Column({ type: 'vector', nullable: true })
  // embedding?: number[];

  @Column({ length: 50, nullable: true })
  source_type?: string;

  @Column({ type: 'uuid', nullable: true })
  source_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}
