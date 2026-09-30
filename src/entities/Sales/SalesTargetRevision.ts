import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';
import { SalesTarget } from './SalesTarget';

/**
 * Append-only history of one target. Written in the SAME transaction as the
 * change it describes — unlike `audit_logs`, which is best-effort and whose
 * every index leads with `tenant` (NULL for platform actions), so per-target
 * history there would be an unindexed scan and could silently drop a row.
 *
 * `before` is NULL on the first revision (create); `after` is NULL on a
 * delete. `reason` is mandatory for a past-month edit (enforced in the
 * service, not the schema, because creation legitimately has none).
 */
@Entity('sales_target_revisions')
@Unique('UQ_sales_target_revisions_target_revision', ['target_id', 'revision'])
export class SalesTargetRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  target_id!: string;

  @ManyToOne(() => SalesTarget, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_id', foreignKeyConstraintName: 'FK_sales_target_revisions_target' })
  target?: SalesTarget;

  @Column({ type: 'int' })
  revision!: number;

  @Column({ type: 'jsonb', nullable: true })
  before?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after?: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason?: string | null;

  @Column({ type: 'uuid' })
  changed_by!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'changed_by', foreignKeyConstraintName: 'FK_sales_target_revisions_user' })
  changed_by_user?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
