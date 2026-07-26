import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { BillingUpgradeRequest } from './BillingUpgradeRequest';
import { User } from '../Auth&RBAC/User';

/**
 * Status-history / audit trail for a BillingUpgradeRequest — one append-only
 * table serving status transitions, the quote snapshot, admin notes, and AI
 * estimate generations (`type` discriminates), mirroring SupportTicketEvent.
 * `internal_only` hides super-admin notes from the tenant-facing detail view.
 */
@Entity('billing_upgrade_request_events')
export class BillingUpgradeRequestEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => BillingUpgradeRequest, { onDelete: 'CASCADE' })
  request!: BillingUpgradeRequest;

  /** 'STATUS_CHANGED' | 'QUOTED' | 'NOTE_ADDED' | 'AI_ESTIMATE_GENERATED' */
  @Column({ length: 32 })
  type!: string;

  @Column({ length: 32, nullable: true })
  from_value?: string;

  @Column({ length: 32, nullable: true })
  to_value?: string;

  @Column({ type: 'text', nullable: true })
  note?: string;

  /** Structured snapshot (e.g. the quote terms or the AI estimate payload). */
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ default: false })
  internal_only!: boolean;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  actor?: User;

  @Column({ length: 160, nullable: true })
  actor_name?: string;

  @Index()
  @CreateDateColumn()
  created_at!: Date;
}
