import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
  Unique,
} from 'typeorm';

import { User } from '../Auth&RBAC/User';

/**
 * One user's opt-out for one internal-notification CATEGORY.
 *
 * Absence of a row means "not muted" — the default is always to notify, so a
 * fresh user needs no setup and no backfill exists. Only rows that actively
 * mute something are stored.
 *
 * MANDATORY CATEGORIES CANNOT BE MUTED. That rule lives in the catalog
 * (`spec.mandatory`), is enforced by `InternalNotificationPreferenceService`
 * when a mute is written, AND is enforced again at emit time — so even a row
 * inserted directly into the database cannot suppress a security notification.
 * Two independent enforcement points, because a single one is a single point
 * of failure for a security control.
 */
@Entity('notification_preferences')
@Unique('UQ_notification_preferences_user_category', ['user', 'category'])
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /** A `NotificationCategory` value. Stored as text so adding a category needs no migration. */
  @Column({ type: 'varchar', length: 32 })
  category!: string;

  @Column({ type: 'boolean', default: false })
  muted!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
