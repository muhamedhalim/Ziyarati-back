import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';

import { RolePermission } from '../Auth&RBAC/RolePermission';
import type {
  PermissionScope,
  RiskLevel,
} from '../../rbac/permission-metadata';

@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ unique: true })
  slug!: string;

  @Index()
  @Column({ nullable: true })
  module?: string;

  /**
   * Human description for admin dashboards. Nullable — absence is meaningful:
   * it is what the "missing description" audit finding reports on.
   */
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Layer the permission operates at (platform | tenant | branch | system).
   * Backfilled from the metadata registry; defaults to `tenant`.
   */
  @Index()
  @Column({ type: 'varchar', length: 16, default: 'tenant' })
  scope!: PermissionScope;

  /**
   * Informational risk classification (low | medium | high | critical).
   * Persisted from the deterministic metadata registry — never used for
   * authorization, only for audit reporting.
   */
  @Index()
  @Column({ type: 'varchar', length: 16, default: 'medium' })
  risk_level!: RiskLevel;

  /**
   * Whether the slug is being phased out. Deprecated permissions stay visible
   * and are never auto-removed from roles; deprecation is an audit signal.
   */
  @Index()
  @Column({ type: 'boolean', default: false })
  is_deprecated!: boolean;

  @OneToMany(
    () => RolePermission,
    (rolePermission) => rolePermission.permission,
  )
  rolePermissions!: RolePermission[];

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
