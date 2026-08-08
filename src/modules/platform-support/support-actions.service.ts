import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import { StaffAccessService } from '../staff/staff-access.service';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { QueueService } from '../../queue/queue.service';

import { SupportClinicResolver } from './support-clinic.resolver';
import { SupportIntegrationService } from './support-integration.service';
import {
  SUPPORT_AUDIT_ENTITY,
  SUPPORT_RESENDABLE_EMAIL_TEMPLATES,
} from './platform-support.constants';

/**
 * ============================================================================
 *  SAFE RECOVERY ACTIONS
 * ============================================================================
 *
 * The complete set of writes Platform Customer Service can perform. Three, all
 * idempotent, all destination-locked, all audited:
 *
 *   1. RESEND one eligible transactional email
 *   2. RETRY  one failed notification
 *   3. RECHECK integration health (a pure re-probe — no state changes at all)
 *
 * THE RULES, and how each is structurally enforced rather than merely
 * documented:
 *
 *   "Never retry all"            — there is no bulk method on this class, and
 *                                  no controller route without an `:id`.
 *   "Never expose queue controls"— nothing here touches BullMQ beyond a
 *                                  liveness ping; the retry goes through the
 *                                  notification domain's own audited override.
 *   "Never construct a payload"  — no DTO on any of these routes carries a
 *                                  body at all. There is nothing to construct.
 *   "Never choose a template"    — the template comes from the STORED
 *                                  `email_logs` row and must be on the
 *                                  `SUPPORT_RESENDABLE_EMAIL_TEMPLATES`
 *                                  allow-list.
 *   "Never alter the destination"— the recipient is re-resolved from the USER
 *                                  record by the existing invitation service.
 *                                  The stored address is used only to LOOK UP
 *                                  which user; it is never sent to.
 *   "Backend re-resolves source" — the delegate services rebuild the token,
 *                                  the URL and the locale from scratch.
 *   "Idempotency"                — invitations issue a fresh single-use token
 *                                  and carry an idempotency key into
 *                                  `email_logs`; the notification retry is the
 *                                  domain's own guarded state transition.
 *
 * DELIBERATE SCOPE DECISION: only CLINIC staff invitations are resendable.
 * PLATFORM staff invitations are excluded even though a resend primitive
 * exists, because Platform Support must not reach Platform Staff management —
 * that surface stays super-admin-only.
 */
@Injectable()
export class SupportActionsService {
  private readonly logger = new Logger(SupportActionsService.name);

  constructor(
    private readonly clinics: SupportClinicResolver,
    private readonly integrations: SupportIntegrationService,
    private readonly staffAccess: StaffAccessService,
    private readonly notifications: NotificationSchedulerService,
    private readonly audit: PlatformAdminAuditService,
    private readonly queues: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  // ── 1. Resend an eligible transactional email ────────────────────────────

  /**
   * Resend the invitation behind a specific `email_logs` row.
   *
   * The caller identifies a RECORD, never a recipient. Everything else —
   * which user, which address, which template, which locale, a fresh token —
   * is rebuilt server-side by `StaffAccessService.resendInvitation`, the same
   * method the clinic's own Owner uses.
   */
  async resendEmail(
    tenantId: string,
    emailLogId: string,
    actorUserId: string,
  ): Promise<{ resent: true; template: string; staffId: string }> {
    await this.clinics.assertExists(tenantId);

    const [row] = await this.dataSource.query(
      `SELECT id, tenant_id, to_address, template
         FROM email_logs WHERE id = $1 AND tenant_id = $2`,
      [emailLogId, tenantId],
    );
    if (!row) {
      // 404 rather than 403: an id belonging to another clinic must not be
      // confirmed to exist, matching every other cross-tenant lookup here.
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Email record not found' });
    }

    if (!SUPPORT_RESENDABLE_EMAIL_TEMPLATES.includes(row.template)) {
      await this.recordRejection(
        PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_EMAIL_RESEND_REJECTED,
        actorUserId,
        tenantId,
        emailLogId,
        { reason: 'template_not_resendable', template: row.template },
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'This kind of email cannot be resent from the support console',
        publicContext: { template: row.template },
      });
    }

    // Resolve the STAFF MEMBER from the stored address. The address is a
    // lookup key only — `resendInvitation` reads the destination from the
    // user record it loads, so even a stale `to_address` cannot redirect mail.
    const [staff] = await this.dataSource.query(
      `SELECT sp.id AS staff_id
         FROM staff_profiles sp
         JOIN users u ON u.id = sp.user_id
        WHERE sp."tenantId" = $1 AND sp.deleted_at IS NULL
          AND lower(u.email) = lower($2) AND u.deleted_at IS NULL
        LIMIT 1`,
      [tenantId, row.to_address],
    );
    if (!staff) {
      await this.recordRejection(
        PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_EMAIL_RESEND_REJECTED,
        actorUserId,
        tenantId,
        emailLogId,
        { reason: 'recipient_no_longer_a_staff_member' },
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The original recipient is no longer a staff member of this clinic',
      });
    }

    // Delegate. This throws UNPROCESSABLE_ENTITY on its own if the person has
    // already signed in (they own their password now and should use
    // forgot-password) or has no address — both correct refusals to inherit.
    await this.staffAccess.resendInvitation(tenantId, staff.staff_id, actorUserId);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_EMAIL_RESENT,
      userId: actorUserId,
      entityType: SUPPORT_AUDIT_ENTITY,
      entityId: emailLogId,
      tenantId,
      // Safe metadata only: which record, which template, which staff member.
      // No address, no token, no rendered content.
      after: { template: row.template, staffId: staff.staff_id },
    });

    return { resent: true, template: row.template, staffId: staff.staff_id };
  }

  // ── 2. Retry one failed notification ─────────────────────────────────────

  /**
   * Retry a single failed / send-uncertain notification.
   *
   * Delegates to `NotificationSchedulerService.retry`, the notification
   * domain's own audited override. That method — not this one — owns the
   * safety rules: it refuses anything outside `RETRYABLE_STATUSES`, clears
   * `send_attempted` so the dispatcher's duplicate-send guard does not
   * immediately re-reject it, and records its own audit row. Reusing it means
   * Support cannot retry something the product itself considers unretryable.
   */
  async retryNotification(
    tenantId: string,
    notificationId: string,
    actorUserId: string,
  ): Promise<{ queued: boolean; notificationId: string; jobId?: string | number | null }> {
    await this.clinics.assertExists(tenantId);

    try {
      const result = await this.notifications.retry(tenantId, notificationId);

      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_NOTIFICATION_RETRIED,
        userId: actorUserId,
        entityType: SUPPORT_AUDIT_ENTITY,
        entityId: notificationId,
        tenantId,
        after: { queued: result.queued, jobId: result.jobId ?? null },
      });

      return result;
    } catch (err) {
      // A refusal is itself worth recording: "Support tried to retry a SENT
      // notification" is exactly the kind of thing an incident review wants.
      await this.recordRejection(
        PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_NOTIFICATION_RETRY_REJECTED,
        actorUserId,
        tenantId,
        notificationId,
        { reason: (err as AppError)?.code ?? 'error' },
      );
      throw err;
    }
  }

  // ── 3. Integration health recheck ────────────────────────────────────────

  /**
   * Re-probe integration health on demand.
   *
   * This is a READ that happens to be a POST, because it is an explicit,
   * attributable operator action rather than a page load. It reconnects
   * nothing, rotates nothing, changes no credential, touches no webhook
   * configuration and writes no integration state — it re-runs exactly the
   * same queries `GET :tenantId/integrations` runs, plus a live Redis ping so
   * "is the backend even reachable right now" is answered fresh rather than
   * from whatever the page cached.
   */
  async recheckIntegrations(tenantId: string, actorUserId: string) {
    await this.clinics.assertExists(tenantId);

    const [overview, redisLatencyMs] = await Promise.all([
      this.integrations.overview(tenantId),
      this.queues.redisPing().catch(() => null),
    ]);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_INTEGRATION_RECHECKED,
      userId: actorUserId,
      entityType: SUPPORT_AUDIT_ENTITY,
      entityId: tenantId,
      tenantId,
      // Only the resulting health verdicts — no credential state, no counts
      // that could be mistaken for tenant data.
      after: {
        whatsapp: overview.whatsapp.health,
        email: overview.email.health,
        payments: overview.payments.health,
        ai: overview.ai.health,
        storage: overview.storage.health,
      },
    });

    return {
      ...overview,
      queueBackend: {
        status: redisLatencyMs === null ? ('down' as const) : ('up' as const),
        latencyMs: redisLatencyMs,
      },
      recheckedAt: new Date().toISOString(),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async recordRejection(
    action:
      | typeof PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_EMAIL_RESEND_REJECTED
      | typeof PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_NOTIFICATION_RETRY_REJECTED,
    actorUserId: string,
    tenantId: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      action,
      userId: actorUserId,
      entityType: SUPPORT_AUDIT_ENTITY,
      entityId,
      tenantId,
      after: metadata,
    });
  }
}
