import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

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

  /** Optional originating tenant, for deep-linking from the notification. */
  @Column({ type: 'uuid', nullable: true })
  tenant_id?: string;

  @Column({ type: 'jsonb', nullable: true })
  data?: Record<string, unknown>;

  @Column({ default: false })
  is_read!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  read_at?: Date;

  @CreateDateColumn()
  created_at!: Date;
}
