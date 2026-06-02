import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Unique,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { AiAgent } from './AiAgent';

@Entity('ai_usage_logs')
@Unique(['tenant', 'agent', 'period_month'])
export class AiUsageLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => AiAgent, { nullable: true })
  agent?: AiAgent;

  @Column({ length: 7 })
  period_month!: string;

  @Column({ default: 0 })
  total_tokens!: number;

  @Column({ default: 0 })
  total_requests!: number;
}