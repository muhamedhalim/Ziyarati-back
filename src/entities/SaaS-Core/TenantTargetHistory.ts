import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum TenantTargetChange {
  /** First time this scope/month/type got a value. */
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  /** Carried over from the legacy standing goal on `tenant_settings`. */
  MIGRATED = 'MIGRATED',
}

/**
 * Append-only ledger of target changes. Scope columns are denormalised
 * copies (no FKs to `tenant_targets`/`branches`) so history survives a
 * branch being deleted and can be filtered without a join.
 */
@Entity('tenant_target_history')
@Index('idx_tenant_target_history_scope', [
  'tenant_id',
  'branch_id',
  'target_type',
  'period_month',
  'changed_at',
])
@Index('idx_tenant_target_history_tenant_changed', ['tenant_id', 'changed_at'])
export class TenantTargetHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenant_id!: string;

  @Column({ type: 'uuid', nullable: true })
  target_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  branch_id!: string | null;

  @Column({ type: 'varchar', length: 16 })
  target_type!: string;

  @Column({ type: 'varchar', length: 7 })
  period_month!: string;

  @Column({ type: 'varchar', length: 16 })
  change_type!: TenantTargetChange;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  previous_value!: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2 })
  new_value!: string;

  @Column({ type: 'uuid', nullable: true })
  actor_user_id!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  changed_at!: Date;
}
