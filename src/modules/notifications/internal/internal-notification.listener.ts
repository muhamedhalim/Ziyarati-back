import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  SUPPORT_TICKET_EVENT,
  TICKET_ACTOR_SIDE,
  type SupportTicketCreatedEvent,
  type SupportTicketRepliedEvent,
  type SupportTicketReopenedEvent,
  type SupportTicketStatusChangedEvent,
} from '../../../events/support-ticket.events';

import {
  TENANT_EVENT,
  type TenantVerificationSubmittedEvent,
} from '../../../events/tenant.events';

import { InternalNotificationService } from './internal-notification.service';
import { preview } from './notification-catalog';

/**
 * Bridges domain events to the INTERNAL notification catalog.
 *
 * Sibling to `NotificationEventListener`, which does the same job for the
 * OUTBOUND patient pipeline. Two listeners rather than one because they answer
 * two different questions — "what should we message the patient?" versus "who
 * on the staff needs to know?" — and because the outbound one is driven by
 * tenant-authored `notification_rules` while this one is driven by the code
 * catalog.
 *
 * ── RESPONSIBILITIES, AND ONLY THESE ────────────────────────────────────────
 *   1. Receive a typed domain event.
 *   2. Choose the catalog key (the one place a routing decision belongs).
 *   3. Shape the event into an emit context.
 * It resolves no recipients, renders no text, writes no rows, and imports
 * nothing from the domains it listens to beyond their event classes.
 *
 * ── WHY ONE `@OnEvent` PER EVENT ────────────────────────────────────────────
 * `EventEmitterModule.forRoot({ wildcard: false })` — a `@OnEvent('**')`
 * handler would silently never fire. Explicit handlers are also what make the
 * complete list of notification-producing events greppable in one file.
 *
 * ── ERROR HANDLING ──────────────────────────────────────────────────────────
 * None here, deliberately: `InternalNotificationService.emit` already catches
 * everything and returns a result rather than throwing. A second try/catch
 * would only obscure that guarantee.
 */
@Injectable()
export class InternalNotificationListener {
  constructor(private readonly notifications: InternalNotificationService) {}

  // ───────────────────────────── Support tickets ──────────────────────────── //

  @OnEvent(SUPPORT_TICKET_EVENT.CREATED)
  async onTicketCreated(event: SupportTicketCreatedEvent): Promise<void> {
    await this.notifications.emit('SUPPORT_TICKET_OPENED', {
      // A PLATFORM-scope notification: the clinic already knows it opened a
      // ticket. `tenantId` is still passed so the row records which clinic it
      // concerns; the resolver ignores it for platform scope.
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      variables: {
        ticketNumber: event.ticketNumber,
        subject: event.subject,
        priority: event.priority,
        clinicName: event.clinicName,
      },
      refs: { ticketId: event.ticketId },
    });
  }

  /**
   * The reported bug, and its mirror image.
   *
   * One event, two destinations: a platform reply notifies the clinic, a clinic
   * reply notifies platform support. Whoever wrote it is never notified of
   * their own reply — `emit` excludes the actor by default.
   */
  @OnEvent(SUPPORT_TICKET_EVENT.REPLIED)
  async onTicketReplied(event: SupportTicketRepliedEvent): Promise<void> {
    const fromPlatform = event.actorSide === TICKET_ACTOR_SIDE.PLATFORM;

    await this.notifications.emit(
      fromPlatform ? 'SUPPORT_TICKET_REPLIED' : 'SUPPORT_TICKET_CUSTOMER_REPLIED',
      {
        tenantId: event.tenantId,
        actorUserId: event.actorUserId,
        variables: {
          ticketNumber: event.ticketNumber,
          subject: event.subject,
          clinicName: event.clinicName,
          responderName: event.actorName,
          // Truncated at the boundary: the stored row keeps a short preview,
          // never the full reply body.
          preview: preview(event.note),
        },
        refs: { ticketId: event.ticketId, eventId: event.eventId },
      },
    );
  }

  /**
   * Only a PLATFORM-driven status change notifies the clinic.
   *
   * A clinic closing its own ticket, or reopening it, is that clinic's own
   * action — it needs no notification back to itself, and the reopen case has
   * its own event aimed at the platform instead.
   */
  @OnEvent(SUPPORT_TICKET_EVENT.STATUS_CHANGED)
  async onTicketStatusChanged(
    event: SupportTicketStatusChangedEvent,
  ): Promise<void> {
    if (event.actorSide !== TICKET_ACTOR_SIDE.PLATFORM) return;

    await this.notifications.emit('SUPPORT_TICKET_STATUS_CHANGED', {
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      variables: {
        ticketNumber: event.ticketNumber,
        subject: event.subject,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
      },
      refs: { ticketId: event.ticketId, eventId: event.eventId },
    });
  }

  @OnEvent(SUPPORT_TICKET_EVENT.REOPENED)
  async onTicketReopened(event: SupportTicketReopenedEvent): Promise<void> {
    await this.notifications.emit('SUPPORT_TICKET_REOPENED', {
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      variables: {
        ticketNumber: event.ticketNumber,
        subject: event.subject,
        clinicName: event.clinicName,
      },
      refs: { ticketId: event.ticketId, eventId: event.eventId },
    });
  }

  // ─────────────────────────── Tenant lifecycle ───────────────────────────── //

  /**
   * Replaces the direct `admin_notifications` write that used to live inside
   * `TenantVerificationService`. Same audience, same deep link — but now one
   * row per administrator, so read state is per-person rather than global.
   */
  @OnEvent(TENANT_EVENT.VERIFICATION_SUBMITTED)
  async onVerificationSubmitted(
    event: TenantVerificationSubmittedEvent,
  ): Promise<void> {
    await this.notifications.emit('VERIFICATION_SUBMITTED', {
      tenantId: event.tenantId,
      actorUserId: event.actorUserId,
      variables: { clinicName: event.clinicName },
    });
  }
}
