import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { AiAgent } from './AiAgent';
import { Tenant } from '../SaaS Core/Tenant';

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

  @CreateDateColumn()
  created_at!: Date;
}