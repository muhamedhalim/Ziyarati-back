import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

import { SupportTicket } from './SupportTicket';
import { User } from '../Auth&RBAC/User';

/**
 * A single audit entry against a ticket — status change, priority change, or an
 * internal admin note. One table serves both "status history" and "admin notes"
 * (`type` discriminates), so the tenant-facing detail view can filter
 * `internal_only = false` while the super-admin view sees everything.
 */
@Entity('support_ticket_events')
export class SupportTicketEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => SupportTicket, { onDelete: 'CASCADE' })
  ticket!: SupportTicket;

  /** 'STATUS_CHANGED' | 'PRIORITY_CHANGED' | 'NOTE_ADDED' */
  @Column({ length: 24 })
  type!: string;

  @Column({ length: 32, nullable: true })
  from_value?: string;

  @Column({ length: 32, nullable: true })
  to_value?: string;

  /** Optional comment on a status/priority change, or the body of an admin note. */
  @Column({ type: 'text', nullable: true })
  note?: string;

  /** Admin notes are internal-only; status/priority changes are tenant-visible. */
  @Column({ default: false })
  internal_only!: boolean;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  actor?: User;

  @Column({ length: 160, nullable: true })
  actor_name?: string;

  /**
   * Snapshot of the actor's side at write time: 'clinic' for a tenant-side
   * action, or an RBAC role slug (e.g. 'super_admin') for a platform-side
   * one — lets the Super Admin UI distinguish who performed each lifecycle
   * step without re-deriving it from the actor's current (possibly changed)
   * roles.
   */
  @Column({ length: 32, nullable: true })
  actor_role?: string;

  // Explicit `timestamptz` — see SupportTicket.created_at's comment: a naive
  // `timestamp` here would be decoded against the Node process's local
  // timezone, corrupting any comparison against a tz-aware sibling column.
  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
