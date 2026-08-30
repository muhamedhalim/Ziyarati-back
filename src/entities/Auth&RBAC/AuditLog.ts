import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  Index,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';

// Mirrors 1730062000000-AuditLogIndexes.ts — the migration is the source of
// truth for the actual DDL (CONCURRENTLY), these decorators just keep the
// entity's declared schema in sync with it.
@Entity('audit_logs')
@Index('IDX_audit_logs_tenant_created', ['tenant', 'created_at'])
@Index('IDX_audit_logs_tenant_action_created', ['tenant', 'action', 'created_at'])
@Index('IDX_audit_logs_tenant_entity', ['tenant', 'entity_type', 'entity_id'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, {
    nullable: true,
  })
  tenant?: Tenant;

  @ManyToOne(() => User, {
    nullable: true,
  })
  user?: User;

  @Column()
  action!: string;

  @Column()
  entity_type!: string;

  @Column({
    type: 'uuid',
    nullable: true,
  })
  entity_id?: string;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  old_values?: Record<string, any>;

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  new_values?: Record<string, any>;

  @Column({
    nullable: true,
  })
  ip_address?: string;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  created_at!: Date;
}