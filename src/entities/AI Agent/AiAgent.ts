import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Branch } from '../SaaS Core/Branch';

@Entity('ai_agents')
export class AiAgent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, { nullable: true })
  branch?: Branch;

  @Column({ length: 255, nullable: true })
  name?: string;

  @Column({ length: 100, nullable: true })
  model?: string;

  @Column({ type: 'text', nullable: true })
  system_prompt?: string;

  @Column({ type: 'numeric', precision: 3, scale: 2, default: 0.2 })
  temperature!: number;

  @Column({ default: true })
  is_active!: boolean;

  @CreateDateColumn()
  created_at!: Date;

  @DeleteDateColumn()
  deleted_at?: Date;
}