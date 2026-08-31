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
import { Branch } from '../SaaS-Core/Branch';

// Mirrors 1730062000000-AuditLogIndexes.ts — the migration is the source of
// truth for the actual DDL (CONCURRENTLY), these decorators just keep the
// entity's declared schema in sync with it.
@Entity('audit_logs')
@Index('IDX_audit_logs_tenant_created', ['tenant', 'created_at'])
@Index('IDX_audit_logs_tenant_action_created', [
  'tenant',
  'action',
  'created_at',
])
@Index('IDX_audit_logs_tenant_entity', ['tenant', 'entity_type', 'entity_id'])
// Mirrors 1730084000000-AuditLogActivityContext.ts — the actor and branch
// filter predicates, which had no index at all before it.
@Index('IDX_audit_logs_tenant_user_created', ['tenant', 'user', 'created_at'])
@Index('IDX_audit_logs_tenant_branch_created', [
  'tenant',
  'branch',
  'created_at',
])
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

  /**
   * The branch the action happened at, when it has one. Nullable by design —
   * a role change or a campaign launch has no branch, and a fabricated one
   * would be worse than none. `ON DELETE SET NULL`: deleting a branch must
   * never destroy the history of what happened at it.
   */
  @ManyToOne(() => Branch, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  branch?: Branch;

  @Column()
  action!: string;

  @Column()
  entity_type!: string;

  @Column({
    type: 'uuid',
    nullable: true,
  })
  entity_id?: string;

  /**
   * A SHORT, NON-SENSITIVE human label for the affected resource ("Dr. Sara
   * Ali", "Summer checkup"), so the Activity UI can show something readable
   * beside the UUID and free-text search has something human to match.
   * Written by audit writers ONLY — never from user input.
   *
   * SECURITY: never a patient name, contact detail or clinical value. That
   * rule is stated and enforced once, at `ActivityAuditService`.
   */
  @Column({
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  entity_label?: string;

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
