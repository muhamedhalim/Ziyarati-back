import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { Tenant } from './Tenant';

/**
 * In-app notification for platform super-admins (e.g. "Clinic X submitted
 * verification for review"). Drives the admin unread badge + notification list.
 * Not tenant-scoped — visible to all super-admins.
 */
@Entity('admin_notifications')
@Index(['is_read', 'created_at'])
export class AdminNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Machine type, e.g. `VERIFICATION_SUBMITTED`. */
  @Column()
  type!: string;

  @Column()
  title!: string;

  @Column({ type: 'text', nullable: true })
  body?: string;

  /**
   * Optional originating tenant, for deep-linking from the notification.
   * P0.7: was a plain `@Column`; now a relation so the FK
   * `1730089000000-TenantIsolationForeignKeys` adds on this same `tenant_id`
   * column is entity-declared — otherwise a `TYPEORM_SYNCHRONIZE=true` boot
   * would DROP it as "old" (P0.1/P0.2's own class of defect, for a foreign
   * key instead of an exclusion constraint). The underlying column, its
   * name and its nullability are unchanged — `@JoinColumn` pins the name so
   * this stays `tenant_id`, not TypeORM's own camelCase default. The one
   * write site (`admin-notification.service.ts`) is updated alongside this.
   */
  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ type: 'jsonb', nullable: true })
  data?: Record<string, unknown>;

  @Column({ default: false })
  is_read!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  read_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}
