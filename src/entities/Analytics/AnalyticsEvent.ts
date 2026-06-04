import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { Branch } from '../SaaS-Core/Branch';

@Entity('analytics_events')
export class AnalyticsEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Branch, {
    nullable: true,
  })
  branch?: Branch;

  @Column({
    nullable: true,
  })
  event_type?: string;

  @Column({
    nullable: true,
  })
  entity_type?: string;

  @Column({
    type: 'uuid',
    nullable: true,
  })
  entity_id?: string;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  metadata?: Record<string, any>;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  created_at!: Date;
}