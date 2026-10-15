import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { InAppNotification } from '../../../entities/Notifications/InAppNotification';
import { User } from '../../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../../common/errors';

import { renderNotification } from './notification-catalog';
import {
  resolveNotificationLocale,
  type NotificationLocale,
} from './notification-keys';
import type { InboxFilterDto } from './dto/inbox-filter.dto';

/** One notification as the inbox and the bell render it. */
export interface InboxItemView {
  id: string;
  key: string;
  category: string;
  priority: string;
  title: string;
  body: string;
  linkUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface InboxPage {
  data: InboxItemView[];
  total: number;
  page: number;
  limit: number;
  /** Unread total for the whole inbox — not just this page — so the bell badge and the list agree in one round trip. */
  unread: number;
}

/**
 * Reads and mutates the CALLER'S OWN internal notifications.
 *
 * ── THE SECURITY SHAPE ──────────────────────────────────────────────────────
 * Every method takes `recipientUserId` as its FIRST parameter, and every query
 * filters on it. The controller always passes the authenticated principal's own
 * id and never a value from the request, so there is no code path in which a
 * caller can name someone else's inbox. That makes the IDOR structurally
 * impossible rather than guarded by a check somebody could later remove.
 *
 * A notification belonging to another user is reported as 404, not 403 — a 403
 * would confirm the id exists, which is itself a disclosure.
 *
 * NOTE ON TENANCY: these methods intentionally do NOT filter on `tenantId`.
 * The recipient is a single user, and a user belongs to exactly one tenant
 * (`users.tenantId`), so the recipient filter already implies tenant isolation.
 * Adding a tenant predicate here would be redundant and, worse, would break a
 * legitimate case — a user whose tenant was later archived must still be able
 * to read why. Isolation is enforced at WRITE time by
 * `NotificationRecipientResolver`; this is the matching read-side guarantee.
 */
@Injectable()
export class InternalNotificationReadService {

  /** Read notifications are purged after this many days. */
  private readonly readRetentionDays = Number(
    process.env.INTERNAL_NOTIFICATION_READ_RETENTION_DAYS ?? '30',
  );

  /** Backstop: anything older than this goes, read or not, so an abandoned inbox cannot grow forever. */
  private readonly maxRetentionDays = Number(
    process.env.INTERNAL_NOTIFICATION_MAX_RETENTION_DAYS ?? '180',
  );

  constructor(
    @InjectRepository(InAppNotification)
    private readonly notifications: Repository<InAppNotification>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /** The caller's inbox, rendered in one language, newest first. */
  async list(
    recipientUserId: string,
    filter: InboxFilterDto,
  ): Promise<InboxPage> {
    const locale = await this.resolveLocale(recipientUserId, filter.locale);

    const qb = this.notifications
      .createQueryBuilder('n')
      .where('n.recipient_user_id = :recipientUserId', { recipientUserId });

    if (filter.status === 'unread') {
      qb.andWhere('n.read_at IS NULL');
    }
    if (filter.category) {
      qb.andWhere('n.category = :category', { category: filter.category });
    }
    if (filter.priority) {
      qb.andWhere('n.priority = :priority', { priority: filter.priority });
    }

    const [rows, total] = await qb
      // Matches IX_in_app_notifications_recipient_created.
      .orderBy('n.created_at', 'DESC')
      // Tie-break on the primary key: two notifications from one event share a
      // created_at to microsecond precision often enough that without this,
      // page 2 can repeat or skip a row.
      .addOrderBy('n.id', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    return {
      data: rows.map((row) => this.toView(row, locale)),
      total,
      page: filter.page,
      limit: filter.limit,
      unread: await this.unreadCount(recipientUserId),
    };
  }

  /**
   * Unread total for the bell badge.
   *
   * Served by the PARTIAL index `IX_in_app_notifications_recipient_unread`
   * (`WHERE read_at IS NULL`), so it stays index-only however much read history
   * accumulates behind it.
   */
  async unreadCount(recipientUserId: string): Promise<number> {
    return this.notifications.count({
      where: { recipient: { id: recipientUserId }, read_at: IsNull() },
    });
  }

  /**
   * Marks one of the caller's own notifications read.
   *
   * The recipient predicate is part of the UPDATE, so an id belonging to
   * someone else simply matches no row — the check and the write are one
   * statement, with no window between them.
   */
  async markRead(recipientUserId: string, id: string): Promise<void> {
    const result = await this.notifications
      .createQueryBuilder()
      .update(InAppNotification)
      .set({ read_at: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('recipient_user_id = :recipientUserId', { recipientUserId })
      // Idempotent: re-reading an already-read notification must not move its
      // timestamp, so an accidental double-click does not rewrite history.
      .andWhere('read_at IS NULL')
      .execute();

    if ((result.affected ?? 0) === 0) {
      // Either it is not the caller's, or it is already read. Distinguish so a
      // repeat call is a success rather than a confusing 404, WITHOUT
      // disclosing the existence of another user's row.
      const alreadyRead = await this.notifications.exists({
        where: {
          id,
          recipient: { id: recipientUserId },
          read_at: Not(IsNull()),
        },
      });
      if (!alreadyRead) {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Notification not found',
        });
      }
    }
  }

  /** Marks every unread notification of the CALLER read. Never anyone else's. */
  async markAllRead(recipientUserId: string): Promise<{ updated: number }> {
    const result = await this.notifications
      .createQueryBuilder()
      .update(InAppNotification)
      .set({ read_at: () => 'now()' })
      .where('recipient_user_id = :recipientUserId', { recipientUserId })
      .andWhere('read_at IS NULL')
      .execute();
    return { updated: result.affected ?? 0 };
  }

  /**
   * Retention sweep, called from the existing minute-cadence
   * `notifications.reap` job rather than a new schedule.
   *
   * Capped per run (the same shape as `NotificationLogService.purgeOlderThan`)
   * so a large backlog is drained over several ticks instead of one long
   * delete holding locks.
   */
  async purgeExpired(batch = 5000): Promise<number> {
    const now = Date.now();
    const readCutoff = new Date(now - this.readRetentionDays * 86_400_000);
    const maxCutoff = new Date(now - this.maxRetentionDays * 86_400_000);

    const result = await this.notifications
      .createQueryBuilder()
      .delete()
      .from(InAppNotification)
      .where(
        `id IN (
           SELECT id FROM in_app_notifications
           WHERE (read_at IS NOT NULL AND created_at < :readCutoff)
              OR created_at < :maxCutoff
           ORDER BY created_at ASC
           LIMIT :batch
         )`,
        { readCutoff, maxCutoff, batch },
      )
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Which language to render in.
   *
   * The caller's active UI locale wins when supplied, so switching the
   * dashboard to Arabic re-renders existing notifications immediately rather
   * than only affecting ones written afterwards. Absent that, the user's stored
   * `preferred_locale`; absent that, English. The extra lookup only happens
   * when no locale was passed.
   */
  private async resolveLocale(
    recipientUserId: string,
    requested?: string,
  ): Promise<NotificationLocale> {
    if (requested) return resolveNotificationLocale(requested);
    const user = await this.users.findOne({
      where: { id: recipientUserId },
      select: { id: true, preferred_locale: true },
    });
    return resolveNotificationLocale(user?.preferred_locale);
  }

  private toView(
    row: InAppNotification,
    locale: NotificationLocale,
  ): InboxItemView {
    const { title, body } = renderNotification(row.key, locale, row.variables);
    return {
      id: row.id,
      key: row.key,
      category: row.category,
      priority: row.priority,
      title,
      body,
      linkUrl: row.link_url ?? null,
      entityType: row.entity_type ?? null,
      entityId: row.entity_id ?? null,
      isRead: !!row.read_at,
      readAt: row.read_at ? row.read_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
