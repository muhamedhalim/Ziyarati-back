import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  APPOINTMENT_EVENT,
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
  AppointmentCreatedEvent,
  AppointmentNoShowEvent,
  AppointmentRescheduledEvent,
  AppointmentUpdatedEvent,
} from '../../events/appointment.events';
import {
  PAYMENT_EVENT,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';
import {
  SUBSCRIPTION_EVENT,
  SubscriptionActivatedEvent,
  SubscriptionCancelledEvent,
  SubscriptionPlanChangedEvent,
  SubscriptionReactivatedEvent,
  SubscriptionTrialStartedEvent,
} from '../../events/subscription.events';

import { WorkflowService } from './workflow.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

/**
 * Bridges EXISTING domain events to the workflow engine (sibling to
 * NotificationEventListener — no domain logic, no cross-module imports beyond
 * the events barrel). For each event it:
 *   1. loads the tenant's active workflows for that trigger,
 *   2. evaluates each workflow's conditions against the event context,
 *   3. creates a WorkflowRun + its enqueue-intent via the transactional outbox
 *      (see WorkflowService.createRunWithOutbox) for async action execution.
 *
 * Every handler is guarded so one bad workflow can never suppress the others or
 * break the event source.
 */
@Injectable()
export class WorkflowEventListener {
  private readonly logger = new Logger(WorkflowEventListener.name);

  constructor(
    private readonly workflows: WorkflowService,
    private readonly ctx: TenantContextService,
  ) {}

  // ── Appointments ──────────────────────────────────────────────────────────

  @OnEvent(APPOINTMENT_EVENT.CREATED)
  onAppointmentCreated(e: AppointmentCreatedEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.CREATED, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
      staffId: e.staffId,
      branchId: e.branchId,
      startAt: e.startAt?.toISOString?.() ?? e.startAt,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.CONFIRMED)
  onAppointmentConfirmed(e: AppointmentConfirmedEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.CONFIRMED, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
      startAt: e.startAt?.toISOString?.() ?? e.startAt,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.CANCELLED)
  onAppointmentCancelled(e: AppointmentCancelledEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.CANCELLED, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
      reason: e.reason,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.COMPLETED)
  onAppointmentCompleted(e: AppointmentCompletedEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.COMPLETED, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.RESCHEDULED)
  onAppointmentRescheduled(e: AppointmentRescheduledEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.RESCHEDULED, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
      newStartAt: e.newStartAt?.toISOString?.() ?? e.newStartAt,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.NO_SHOW)
  onAppointmentNoShow(e: AppointmentNoShowEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.NO_SHOW, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
    });
  }

  @OnEvent(APPOINTMENT_EVENT.UPDATED)
  onAppointmentUpdated(e: AppointmentUpdatedEvent) {
    return this.trigger(e.tenantId, APPOINTMENT_EVENT.UPDATED, {
      appointmentId: e.appointmentId,
      customerId: e.customerId,
      changes: e.changes,
    });
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  onPaymentSucceeded(e: PaymentSucceededEvent) {
    return this.trigger(e.tenantId, PAYMENT_EVENT.SUCCEEDED, {
      customerId: e.customerId,
      amount: e.amount,
      currency: e.currency,
    });
  }

  @OnEvent(PAYMENT_EVENT.REFUNDED)
  onPaymentRefunded(e: PaymentRefundedEvent) {
    return this.trigger(e.tenantId, PAYMENT_EVENT.REFUNDED, {
      customerId: e.customerId,
      amount: e.amount,
      currency: e.currency,
    });
  }

  @OnEvent(PAYMENT_EVENT.FAILED)
  onPaymentFailed(e: PaymentFailedEvent) {
    return this.trigger(e.tenantId, PAYMENT_EVENT.FAILED, { customerId: e.customerId });
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  @OnEvent(SUBSCRIPTION_EVENT.ACTIVATED)
  onSubscriptionActivated(e: SubscriptionActivatedEvent) {
    return this.trigger(e.tenantId, SUBSCRIPTION_EVENT.ACTIVATED, { tenantId: e.tenantId });
  }

  @OnEvent(SUBSCRIPTION_EVENT.TRIAL_STARTED)
  onSubscriptionTrialStarted(e: SubscriptionTrialStartedEvent) {
    return this.trigger(e.tenantId, SUBSCRIPTION_EVENT.TRIAL_STARTED, { tenantId: e.tenantId });
  }

  @OnEvent(SUBSCRIPTION_EVENT.CANCELLED)
  onSubscriptionCancelled(e: SubscriptionCancelledEvent) {
    return this.trigger(e.tenantId, SUBSCRIPTION_EVENT.CANCELLED, { tenantId: e.tenantId });
  }

  @OnEvent(SUBSCRIPTION_EVENT.PLAN_CHANGED)
  onSubscriptionPlanChanged(e: SubscriptionPlanChangedEvent) {
    return this.trigger(e.tenantId, SUBSCRIPTION_EVENT.PLAN_CHANGED, { tenantId: e.tenantId });
  }

  @OnEvent(SUBSCRIPTION_EVENT.REACTIVATED)
  onSubscriptionReactivated(e: SubscriptionReactivatedEvent) {
    return this.trigger(e.tenantId, SUBSCRIPTION_EVENT.REACTIVATED, { tenantId: e.tenantId });
  }

  // ── Core ──────────────────────────────────────────────────────────────────

  /**
   * Fan a domain event out to every matching active workflow. Conditions are
   * evaluated here so runs are only created for workflows that will actually act;
   * a SKIPPED run is intentionally not persisted (keeps the audit log signal-rich).
   */
  private async trigger(
    tenantId: string,
    eventName: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    let active;
    try {
      active = await this.workflows.findActiveByTrigger(tenantId, eventName);
    } catch (err) {
      this.logger.error(`load workflows for ${eventName} failed: ${(err as Error)?.message}`);
      return;
    }

    for (const workflow of active) {
      try {
        if (!this.workflows.evaluateConditions(workflow.conditions, context)) continue;
        if (!workflow.actions || workflow.actions.length === 0) continue;
        // Captured NOW, not left to auto-stamping at relay time — same
        // reasoning as CampaignExecutionService's outbox writes (the relay's
        // poll loop has no request/job in flight to inherit a correlationId from).
        await this.workflows.createRunWithOutbox(tenantId, workflow, context, this.ctx.getCorrelationId() ?? undefined);
      } catch (err) {
        this.logger.error(`workflow ${workflow.id} dispatch failed: ${(err as Error)?.message}`);
      }
    }
  }
}
