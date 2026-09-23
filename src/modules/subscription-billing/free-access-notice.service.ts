import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EmailService } from '../email/email.service';
import { InternalNotificationService } from '../notifications/internal/internal-notification.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  freeAccessExpiryEmailKey,
  freeAccessStartEmailKey,
} from './free-access-notice-keys';

/** One row of everything `deliver()` needs, re-read fresh for every delivery. */
interface DeliverableOverride {
  id: string;
  tenant_id: string;
  tenant_name: string;
  contact_email: string | null;
  starts_at: string;
  ends_at: string | null;
  status: 'ACTIVE' | 'REVOKED';
  tenant_deleted_at: string | null;
}

export interface FreeAccessNoticeJob {
  overrideId: string;
  kind: 'STARTED' | 'EXPIRING';
  /** Only meaningful for `EXPIRING` — see `PlatformFreeAccessNoticeJob`. */
  endsAt?: string;
}

/**
 * Delivers one free-access lifecycle notice (in-app + email) — the START
 * event enqueued by `FreeAccessOverrideService.grant`, or an EXPIRING
 * warning enqueued by this service's own `sweepExpiring` (added in the plan's
 * next phase). Worker-only: provided in `WorkerModule`, not the API module,
 * so an API-only deployment never needs `InternalNotificationService`'s
 * dependencies wired in just to satisfy this constructor.
 *
 * WHY NO `@OnEvent` LISTENER, unlike every other internal notification.
 * Every other catalog key is emitted by `internal-notification.listener.ts`
 * reacting to a domain event, fire-and-forget from the caller's point of
 * view. This one is driven by a BullMQ job instead, specifically so a
 * failure can be RETRIED as one unit: `deliver()` inspects
 * `InternalNotificationService.emit()`'s returned `EmitResult.error` (that
 * service never throws — see its own docblock) and throws when it is set,
 * which BullMQ's normal attempts/backoff then retries. An event listener has
 * no caller left to report a failure to once the triggering transaction has
 * already committed.
 *
 * IDEMPOTENCY. Both channels are protected by a DATABASE uniqueness
 * constraint, not by anything in this class: the in-app insert is
 * `(recipient_user_id, dedupe_key)` (partial unique, `ON CONFLICT DO
 * NOTHING`), and the email send is `email_logs.idempotency_key` (unique,
 * atomically claimed). A redelivered BullMQ job — a stalled-job requeue, a
 * manual retry from the failed set — is therefore safe to run all the way
 * through a second time: both channels resolve to "already done, nothing to
 * do" rather than a second notification.
 *
 * STALENESS. The override is re-read fresh from the database on every
 * delivery rather than trusting the job payload's snapshot — see
 * `isStale()`. A revoked override, a deleted tenant, or (for an EXPIRING
 * job specifically) an override that was extended to a different `ends_at`
 * after the sweep claimed it, all skip delivery rather than sending a notice
 * that no longer describes reality.
 */
@Injectable()
export class FreeAccessNoticeService {
  private readonly logger = new Logger(FreeAccessNoticeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: InternalNotificationService,
    private readonly email: EmailService,
    private readonly metrics: MetricsService,
  ) {}

  async deliver(job: FreeAccessNoticeJob): Promise<void> {
    const kindLabel = job.kind === 'STARTED' ? 'started' : 'expiring';
    const row = await this.loadOverride(job.overrideId);

    if (!row || this.isStale(row, job)) {
      this.logger.log(
        `free-access notice overrideId=${job.overrideId} kind=${job.kind} outcome=stale`,
      );
      this.metrics.recordFreeAccessNotice(kindLabel, 'in_app', 'stale');
      this.metrics.recordFreeAccessNotice(kindLabel, 'email', 'stale');
      return;
    }

    await this.deliverInApp(job, row);
    await this.deliverEmail(job, row);
  }

  /**
   * A row that no longer exists, belongs to a deleted tenant, was revoked,
   * has already fully expired, or — for `EXPIRING` — no longer matches the
   * `ends_at` the sweep claimed it for (it was extended in between) is
   * "stale": something true when the job was enqueued has since changed, and
   * sending would describe a state that no longer holds.
   */
  private isStale(row: DeliverableOverride, job: FreeAccessNoticeJob): boolean {
    if (row.tenant_deleted_at !== null) return true;
    if (row.status !== 'ACTIVE') return true;
    if (row.ends_at !== null && new Date(row.ends_at) <= new Date()) {
      return true;
    }
    if (job.kind === 'EXPIRING') {
      const currentEndsAt = row.ends_at
        ? new Date(row.ends_at).toISOString()
        : null;
      if (!job.endsAt || currentEndsAt !== new Date(job.endsAt).toISOString()) {
        return true;
      }
    }
    return false;
  }

  private async loadOverride(
    overrideId: string,
  ): Promise<DeliverableOverride | null> {
    const rows: DeliverableOverride[] = await this.dataSource.query(
      `SELECT o.id, o.tenant_id, o.starts_at, o.ends_at, o.status,
              t.name AS tenant_name, t.contact_email,
              t.deleted_at AS tenant_deleted_at
       FROM free_access_overrides o
       JOIN tenants t ON t.id = o.tenant_id
       WHERE o.id = $1`,
      [overrideId],
    );
    return rows[0] ?? null;
  }

  private async deliverInApp(
    job: FreeAccessNoticeJob,
    row: DeliverableOverride,
  ): Promise<void> {
    const kindLabel = job.kind === 'STARTED' ? 'started' : 'expiring';
    const endsAt = row.ends_at ? new Date(row.ends_at) : null;

    const result = await this.notifications.emit(
      job.kind === 'STARTED' ? 'FREE_ACCESS_STARTED' : 'FREE_ACCESS_EXPIRING',
      {
        tenantId: row.tenant_id,
        variables:
          job.kind === 'STARTED'
            ? {
                clinicName: row.tenant_name,
                endsAt: endsAt ? endsAt.toISOString() : 'no end date',
                durationDays: this.formatDurationDays(row),
              }
            : {
                endsAt: endsAt ? endsAt.toISOString() : '',
                daysRemaining: this.daysRemaining(endsAt),
              },
        refs: {
          overrideId: row.id,
          endsAt: endsAt ? endsAt.toISOString() : undefined,
        },
      },
    );

    if (result.error) {
      this.metrics.recordFreeAccessNotice(kindLabel, 'in_app', 'failed');
      // Propagates to BullMQ's attempts/backoff — see this class's docblock
      // on why `deliver()`, unlike every `@OnEvent` listener, is allowed to
      // throw here.
      throw new Error(
        `free-access in-app notice failed for override ${row.id} (${job.kind}): ${result.error}`,
      );
    }
    if (result.resolved === 0) {
      this.metrics.recordFreeAccessNotice(kindLabel, 'in_app', 'no_recipient');
    } else if (result.created === 0) {
      this.metrics.recordFreeAccessNotice(kindLabel, 'in_app', 'duplicate');
    } else {
      this.metrics.recordFreeAccessNotice(kindLabel, 'in_app', 'sent');
    }
  }

  private async deliverEmail(
    job: FreeAccessNoticeJob,
    row: DeliverableOverride,
  ): Promise<void> {
    const kindLabel = job.kind === 'STARTED' ? 'started' : 'expiring';
    if (!row.contact_email) {
      // Not `stale` — the override itself is perfectly live, there simply is
      // nowhere to send an email. In-app may still have succeeded above.
      this.metrics.recordFreeAccessNotice(kindLabel, 'email', 'no_recipient');
      return;
    }

    // D1 — the recipient's own preference when the owner account is
    // discoverable by `contact_email`, else the delivery service's own
    // `EMAIL_DEFAULT_LOCALE` fallback (passing `locale: undefined` is exactly
    // what triggers that fallback — see `EmailDeliveryService`).
    const [user]: { preferred_locale: string | null }[] =
      await this.dataSource.query(
        `SELECT preferred_locale FROM users WHERE email = $1 LIMIT 1`,
        [row.contact_email],
      );
    const locale = user?.preferred_locale ?? undefined;
    const endsAt = row.ends_at ? new Date(row.ends_at) : null;

    if (job.kind === 'STARTED') {
      this.email.sendFreeAccessNotification({
        to: row.contact_email,
        event: 'started',
        clinicName: row.tenant_name,
        durationDays: this.formatDurationDays(row),
        endsAt: endsAt ? endsAt.toISOString() : 'no end date',
        tenantId: row.tenant_id,
        locale,
        idempotencyKey: freeAccessStartEmailKey(row.id),
      });
    } else {
      // `isStale` already guaranteed `endsAt` matches the claimed date and is
      // non-null for an EXPIRING job.
      this.email.sendFreeAccessNotification({
        to: row.contact_email,
        event: 'expiring',
        endsAt: endsAt!.toISOString(),
        daysRemaining: this.daysRemaining(endsAt),
        tenantId: row.tenant_id,
        locale,
        idempotencyKey: freeAccessExpiryEmailKey(row.id, endsAt!),
      });
    }
    // `EmailService.send` is best-effort and queues asynchronously (or
    // delivers inline under `EMAIL_SYNC`) — it never reports back whether
    // the send itself was a duplicate or failed. That distinction is already
    // fully visible via `email_logs.status` (surfaced to the admin overview
    // by `FreeAccessOverrideService.attachEmailStatus`), so `sent` here means
    // only "handed to the send pipeline", not "delivered".
    this.metrics.recordFreeAccessNotice(kindLabel, 'email', 'sent');
  }

  /** Pre-normalized for both the in-app and email renderers — see their variable declarations. */
  private formatDurationDays(row: DeliverableOverride): string {
    if (!row.ends_at) return 'unlimited';
    const days = Math.round(
      (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) /
        86_400_000,
    );
    return String(days);
  }

  private daysRemaining(endsAt: Date | null): string {
    if (!endsAt) return '0';
    return String(
      Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000)),
    );
  }
}
