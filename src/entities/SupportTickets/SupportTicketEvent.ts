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

  @Index()
  @CreateDateColumn()
  created_at!: Date;
}
