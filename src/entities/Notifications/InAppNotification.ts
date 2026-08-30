import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';

import { Tenant } from '../SaaS-Core/Tenant';
import { User } from '../Auth&RBAC/User';

/**
 * An INTERNAL, in-app notification addressed to ONE staff user.
 *
 * Deliberately distinct from every other table in this folder:
 *   - `notification_templates` / `notification_rules` / `scheduled_notifications`
 *     / `notification_logs` are the OUTBOUND patient-messaging pipeline
 *     (WhatsApp). They address a `Customer`, not a `User`, and carry no read
 *     state because a patient never "reads" a row in our database.
 *   - `admin_notifications` is the legacy super-admin feed. Its `is_read` is a
 *     single global boolean, so one admin marking a notification read clears
 *     the badge for every other admin. That is why this table is per-recipient
 *     rather than an extension of it.
 *
 * ONE ROW PER RECIPIENT. Fan-out happens at write time, which is what makes
 * `read_at` genuinely per-user and the unread count an index-only count.
 *
 * TITLE/BODY ARE NOT STORED. The row keeps `key` + `variables`; the text is
 * rendered at READ time from the code-owned catalog in the *reader's* locale.
 * That is what lets one row serve an Arabic and an English reader, and lets a
 * copy fix apply retroactively without a data migration.
 *
 * TENANT SCOPE: `tenant` NULL means a PLATFORM-scope notification (its
 * recipient is a user with `users.tenantId IS NULL`). For a tenant-scope
 * notification, `tenant.id` always equals the recipient's own
 * `users.tenantId` — the resolver is what guarantees this, and
 * `internal-notifications-negative.e2e-spec.ts` is what proves it.
 */
@Entity('in_app_notifications')
// Inbox list: newest-first for one recipient.
@Index('IX_in_app_notifications_recipient_created', ['recipient', 'created_at'])
// Retention purge + support diagnostics by clinic.
@Index('IX_in_app_notifications_tenant_created', ['tenant', 'created_at'])
export class InAppNotification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Originating clinic, or NULL for a platform-scope notification. Unlike
   * `admin_notifications.tenant_id` (a bare column with no FK), this is a real
   * relation with ON DELETE CASCADE — deleting a clinic takes its
   * notifications with it.
   */
  @ManyToOne(() => Tenant, { nullable: true, onDelete: 'CASCADE' })
  tenant?: Tenant | null;

  /**
   * The one user this notification belongs to. CASCADE because a deleted user's
   * inbox has no meaning and must not linger as orphaned rows.
   */
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_user_id' })
  recipient!: User;

  /** Catalog key, e.g. `SUPPORT_TICKET_REPLIED`. Renders title/body at read time. */
  @Column({ type: 'varchar', length: 64 })
  key!: string;

  /** Denormalized from the catalog so filtering never needs the catalog in SQL. */
  @Column({ type: 'varchar', length: 32 })
  category!: string;

  @Column({ type: 'varchar', length: 16, default: 'NORMAL' })
  priority!: string;

  /** Values substituted into the catalog's renderers. Never pre-rendered text. */
  @Column({ type: 'jsonb', nullable: true })
  variables?: Record<string, unknown> | null;

  /** RELATIVE app path for the deep link (e.g. `/app/support?ticket=…`). Never absolute — the frontend owns the origin and the locale prefix. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  link_url?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  entity_type?: string | null;

  @Column({ type: 'uuid', nullable: true })
  entity_id?: string | null;

  /**
   * Business key for idempotency, UNIQUE **per recipient** (partial index, see
   * the migration) — deliberately NOT global.
   *
   * `scheduled_notifications.source_ref` is globally unique, which is safe only
   * because every key it holds is UUID-derived (`workflow-action:{runId}:{i}`).
   * Catalog dedupe keys are human-readable (`ticket:{id}:reply:{eventId}`), so
   * a global index would make two clinics collide. Scoping the uniqueness to
   * the recipient removes that class of bug entirely, and doubles as the
   * cooldown mechanism when the key embeds a time bucket.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  dedupe_key?: string | null;

  /** NULL = unread. Per-row, therefore genuinely per-user. */
  @Column({ type: 'timestamptz', nullable: true })
  read_at?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
