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
export class AiKnowledgeBase {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => AiAgent, { onDelete: 'CASCADE' })
  agent!: AiAgent;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'vector', nullable: true })
  embedding?: number[];

  @Column({ length: 50, nullable: true })
  source_type?: string;

  @Column({ type: 'uuid', nullable: true })
  source_id?: string;

  @CreateDateColumn()
  created_at!: Date;
}