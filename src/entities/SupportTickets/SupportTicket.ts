import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';

/**
 * A tenant-raised support ticket, triaged and managed by platform super-admins.
 *
 * `category`/`priority`/`status` are `character varying` + a TS union (not a DB
 * enum) — matches the Workflow-era convention so migrations stay additive.
 * Validity is enforced at the DTO/service layer via the constants in
 * `support-tickets.constants.ts`.
 *
 * Creator identity is snapshotted (`created_by_name`/`created_by_email`) at
 * creation time so ticket history survives the user being deleted later; the
 * `createdBy` relation is kept for live joins when the user still exists.
 */
@Entity('support_tickets')
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @ManyToOne(() => Tenant, { nullable: false })
  tenant!: Tenant;

  @Index({ unique: true })
  @Column({ length: 20 })
  ticket_number!: string;

  @Column({ length: 200 })
  subject!: string;

  /** 'technical' | 'administrative' | 'other' */
  @Index()
  @Column({ length: 24 })
  category!: string;

  /** 'low' | 'medium' | 'high' | 'urgent' */
  @Index()
  @Column({ length: 16 })
  priority!: string;

  /** 'open' | 'in_progress' | 'waiting_for_tenant' | 'resolved' | 'closed' */
  @Index()
  @Column({ length: 24, default: 'open' })
  status!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ nullable: true })
  attachment_key?: string;

  @Column({ length: 255, nullable: true })
  attachment_filename?: string;

  @Column({ length: 100, nullable: true })
  attachment_mime_type?: string;

  @Column({ type: 'int', nullable: true })
  attachment_size?: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  createdBy?: User;

  @Column({ length: 160, nullable: true })
  created_by_name?: string;

  @Column({ length: 255, nullable: true })
  created_by_email?: string;

  // Typed `Date | null` (not `| undefined`) so reopening can explicitly clear
  // these via `= null` — TypeORM's `save()` skips `undefined` properties but
  // persists an explicit `null` as `SET column = NULL`.
  @Column({ type: 'timestamptz', nullable: true })
  resolved_at?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at?: Date | null;

  /** Optional — when the clinic would like support to call them back. */
  @Column({ type: 'timestamptz', nullable: true })
  preferred_contact_time?: Date | null;

  // Explicit `timestamptz` (matching resolved_at/closed_at/preferred_contact_time)
  // — without it TypeORM/pg defaults to a naive `timestamp`, which the pg
  // driver decodes as if it were already in the Node process's local
  // timezone. That silently corrupts any duration computed against a
  // `timestamptz` sibling column whenever the process isn't running in UTC
  // (see SupportTicketTimelineAndContactTime migration for the backfill).
  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
