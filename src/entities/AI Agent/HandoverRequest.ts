import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS Core/Tenant';
import { Conversation } from '../Conversations/Conversation';
import { User } from '../Auth&RBAC/User';

@Entity('handover_requests')
@Index(['tenant', 'status'])
export class HandoverRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant)
  tenant!: Tenant;

  @ManyToOne(() => Conversation)
  conversation!: Conversation;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Column({ length: 20, default: 'PENDING' })
  status!: string;

  @ManyToOne(() => User, { nullable: true })
  assigned_to?: User;

  @CreateDateColumn()
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at?: Date;
}