import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';

@Entity('webhook_logs')
@Index(['tenant', 'created_at'])
export class WebhookLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, { nullable: true })
  tenant?: Tenant;

  @Column({ type: 'varchar', length: 50, nullable: true })
  source?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  event_type?: string;

  @Column({ type: 'jsonb', nullable: true })
  payload?: any;

  @Column({ type: 'varchar', length: 20, nullable: true })
  status?: string;

  @Column({ type: 'text', nullable: true })
  error_message?: string;

  @CreateDateColumn()
  created_at!: Date;
}