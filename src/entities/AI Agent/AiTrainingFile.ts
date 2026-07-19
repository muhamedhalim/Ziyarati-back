import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { AiAgent } from './AiAgent';
import { Tenant } from '../SaaS-Core/Tenant';

@Entity('ai_training_files')
export class AiTrainingFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => AiAgent, { nullable: true })
  agent?: AiAgent;

  @Column({ length: 255 })
  file_name!: string;

  @Column({ type: 'text' })
  file_url!: string;

  @Column({ length: 20, nullable: true })
  file_type?: string;

  @Column({ length: 20, default: 'PENDING' })
  status!: string;

  @Column({ length: 60, nullable: true })
  error_code?: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 0 })
  chunk_count!: number;

  @Column({ length: 64, nullable: true })
  content_hash?: string;

  @Column({ type: 'timestamptz', nullable: true })
  processing_started_at?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  indexed_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}
