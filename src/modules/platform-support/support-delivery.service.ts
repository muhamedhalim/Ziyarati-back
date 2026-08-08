import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SupportClinicResolver } from './support-clinic.resolver';
import { QuerySupportDeliveryDto } from './dto/query-support-diagnostics.dto';
import { isoOrNull, maskEmail, sanitizeFailureReason } from './support-privacy.util';

/**
 * "Why didn't the clinic / patient receive the message?"
 *
 * Two histories, both read-only, both paginated and date-bounded:
 *   - EMAIL         from `email_logs`
 *   - NOTIFICATIONS from `notification_logs` (WhatsApp / SMS / push / in-app)
 *
 * NO MESSAGE CONTENT IS EVER RETURNED. `email_logs` stores no body by design
 * (see the entity docstring) and `notification_logs` stores none either — but
 * both carry a `metadata`/error column that can contain arbitrary text, so the
 * queries below name their columns and every failure string passes through
 * `sanitizeFailureReason` before it leaves.
 *
 * RECIPIENTS ARE MASKED. A support agent needs to confirm "yes, that's the
 * address on the ticket", not to read the clinic's contact list. The filter
 * still matches the STORED value server-side, so searching by a real address
 * works while the response discloses only `m***@gmail.com`.
 */
@Injectable()
export class SupportDeliveryService {
  constructor(
    private readonly clinics: SupportClinicResolver,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Email delivery history.
   *
   * `email_logs.status` is `QUEUED | SENT | FAILED`. There is deliberately no
   * synthetic "DELIVERED" — the platform does not ingest provider delivery
   * webhooks for email, so claiming delivery would be a fabrication. `SENT`
   * means "the provider accepted it", which is exactly what the row records.
   */
  async emails(tenantId: string, query: QuerySupportDeliveryDto) {
    await this.clinics.assertExists(tenantId);

    const params: unknown[] = [tenantId, query.since()];
    const filters: string[] = ['tenant_id = $1', 'created_at >= $2'];

    if (query.status) {
      params.push(query.status.toUpperCase());
      filters.push(`status = $${params.length}`);
    }
    if (query.recipient) {
      params.push(`%${query.recipient}%`);
      filters.push(`to_address ILIKE $${params.length}`);
    }
    const where = filters.join(' AND ');

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM email_logs WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT id, to_address, template, subject, locale, status, provider,
               provider_message_id, error, attempts, created_at, sent_at
          FROM email_logs
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: EmailLogRow) => ({
        id: r.id,
        template: r.template,
        // Subject is a rendered template heading (e.g. "You've been invited"),
        // never message body and never patient content.
        subject: r.subject ?? null,
        locale: r.locale,
        channel: 'EMAIL' as const,
        recipient: maskEmail(r.to_address),
        status: r.status,
        provider: r.provider ?? null,
        // Already treated as non-sensitive: it is the id a support agent
        // quotes to the provider, and it identifies a message, not a person.
        providerMessageId: r.provider_message_id ?? null,
        attempts: r.attempts,
        failureReason: sanitizeFailureReason(r.error),
        createdAt: isoOrNull(r.created_at),
        sentAt: isoOrNull(r.sent_at),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
      windowDays: query.days,
    };
  }

  /**
   * Notification delivery history across every non-email channel.
   *
   * Two status axes are reported separately because the platform tracks them
   * separately and conflating them hides real failures: `status` is the SEND
   * lifecycle owned by the worker (did we hand it to the provider?), while a
   * carrier's own feedback arrives later. `SEND_UNCERTAIN` is surfaced
   * verbatim rather than folded into FAILED — it means a worker crashed after
   * the send attempt, so whether the message arrived is genuinely unknown, and
   * that distinction is the whole point of the state.
   *
   * `recipient_id` is a UUID, not contact data, and is returned unmasked so an
   * agent can correlate it with an appointment diagnostic. No name, phone or
   * address is joined in.
   */
  async notifications(tenantId: string, query: QuerySupportDeliveryDto) {
    await this.clinics.assertExists(tenantId);

    const params: unknown[] = [tenantId, query.since()];
    const filters: string[] = ['"tenantId" = $1', 'created_at >= $2'];

    if (query.status) {
      params.push(query.status.toUpperCase());
      filters.push(`status = $${params.length}`);
    }
    const where = filters.join(' AND ');

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM notification_logs WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT id, template_id, recipient_type, recipient_id, channel, status,
               provider_ref, error_message, created_at, sent_at, claimed_at
          FROM notification_logs
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    return {
      data: rows.map((r: NotificationLogRow) => ({
        id: r.id,
        template: r.template_id ?? null,
        channel: r.channel ?? null,
        recipientType: r.recipient_type ?? null,
        /** Opaque id for correlation — never a name, phone or address. */
        recipientId: r.recipient_id ?? null,
        status: r.status ?? null,
        providerMessageId: r.provider_ref ?? null,
        failureReason: sanitizeFailureReason(r.error_message),
        createdAt: isoOrNull(r.created_at),
        /** When the worker claimed it — distinguishes "in flight" from "stuck". */
        claimedAt: isoOrNull(r.claimed_at),
        sentAt: isoOrNull(r.sent_at),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
      windowDays: query.days,
    };
  }
}

interface EmailLogRow {
  id: string;
  to_address: string;
  template: string;
  subject: string | null;
  locale: string;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  sent_at: Date | null;
}

interface NotificationLogRow {
  id: string;
  template_id: string | null;
  recipient_type: string | null;
  recipient_id: string | null;
  channel: string | null;
  status: string | null;
  provider_ref: string | null;
  error_message: string | null;
  created_at: Date;
  sent_at: Date | null;
  claimed_at: Date | null;
}
