import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import { AppError, ErrorCode } from '../../common/errors';
import {
  PAYMENT_EVENT,
  PaymentFailedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';

import { FeatureFlagService } from '../subscription-billing/feature-flag.service';
import { isFeatureKey } from '../subscription-billing/feature-registry';
import { TenantUsageLimitOverrideService } from '../subscription-billing/tenant-usage-limit-override.service';

import { BillingUpgradeEventService } from './billing-upgrade-event.service';
import { lockRequestByPayment } from './billing-upgrade-lock.util';
import {
  BILLING_UPGRADE_BILLING_PERIOD,
  BILLING_UPGRADE_EVENT_TYPE,
  BILLING_UPGRADE_STATUS,
  BILLING_UPGRADE_TYPE,
} from './billing-upgrade.constants';

/**
 * Bridges confirmed payments to billing-upgrade entitlements — the ONLY path
 * that applies a feature grant or usage-limit raise. Mirrors
 * `AppointmentPaymentListener` exactly: these events fire ONLY after a
 * verified, deduplicated, COMMITTED payment state change (webhook / gateway
 * verify) — never from a browser redirect — so this listener may trust them.
 *
 * Exactly-once guarantee: the request row is re-locked (`pessimistic_write`)
 * and its status re-checked INSIDE the same transaction that applies the
 * entitlement and flips the status to `completed` — a retried/duplicated
 * webhook re-delivery finds `status === 'completed'` already and no-ops.
 *
 * Failures are logged, never rethrown — a hiccup here must not fail the
 * payment webhook response (same rationale as AppointmentPaymentListener).
 */
@Injectable()
export class BillingUpgradeEntitlementListener {
  private readonly logger = new Logger('BillingUpgradeEntitlementListener');

  constructor(
    private readonly dataSource: DataSource,
    private readonly featureFlags: FeatureFlagService,
    private readonly limitOverrides: TenantUsageLimitOverrideService,
    private readonly history: BillingUpgradeEventService,
  ) {}

  /** Fast path: the in-process event. Failures are logged, never rethrown. */
  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  async onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
    try {
      await this.applyPaid(event.paymentId);
    } catch (err) {
      this.logger.error(
        `Failed to apply entitlement for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Apply the entitlement for a CAPTURED payment. Idempotent (see the class
   * doc) and — unlike the event handler above — it THROWS on failure: the
   * durable `payments.outcome` consumer (REL-005) calls this directly and needs
   * the error so the job is retried instead of being marked done.
   */
  async applyPaid(paymentId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BillingUpgradeRequest);
      // Lock first, join after: FOR UPDATE + a LEFT JOINed relation (or a filter
      // through the nullable `payment` relation) is refused by Postgres.
      const request = await lockRequestByPayment(manager, paymentId, {
        tenant: true,
      });
      if (!request) return; // not a billing-upgrade payment

      // Idempotent: already applied (this is a duplicate/re-delivered event).
      if (request.status === BILLING_UPGRADE_STATUS.COMPLETED) return;

      if (
        request.type === BILLING_UPGRADE_TYPE.FEATURE &&
        request.feature_key
      ) {
        // The stored key came from a request row that predates the typed
        // registry, so it is validated here rather than trusted: a stale or
        // renamed key must fail loudly at grant time, not silently write a
        // flag that grants nothing and leave the customer paid-but-blocked.
        if (!isFeatureKey(request.feature_key)) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: `Billing upgrade names an unknown feature "${request.feature_key}"`,
            publicContext: { featureKey: request.feature_key },
          });
        }
        await this.featureFlags.set(
          request.tenant.id,
          request.feature_key,
          true,
          { source: FeatureFlagSource.BILLING_UPGRADE, manager },
        );
      } else if (
        request.type === BILLING_UPGRADE_TYPE.USAGE_LIMIT &&
        request.usage_metric &&
        request.approved_quantity !== undefined
      ) {
        await this.limitOverrides.grantOrExtend(
          request.tenant.id,
          request.usage_metric,
          {
            overrideLimit: Number(request.approved_quantity),
            sourceRequestId: request.id,
            expiresAt: this.computeExpiry(request.billing_period),
          },
          manager,
        );
      }

      const fromStatus = request.status;
      request.status = BILLING_UPGRADE_STATUS.COMPLETED;
      request.completed_at = new Date();
      const saved = await repo.save(request);

      await this.history.record(
        {
          requestId: saved.id,
          type: BILLING_UPGRADE_EVENT_TYPE.STATUS_CHANGED,
          fromValue: fromStatus,
          toValue: BILLING_UPGRADE_STATUS.COMPLETED,
          note: 'Payment confirmed — entitlement applied.',
          metadata: { paymentId },
        },
        manager,
      );
    });
  }

  /** Fast path: the in-process event. Failures are logged, never rethrown. */
  @OnEvent(PAYMENT_EVENT.FAILED)
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
    try {
      await this.applyFailed(event.paymentId);
    } catch (err) {
      this.logger.error(
        `Failed to record payment failure for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }

  /** Throwing twin of {@link onPaymentFailed} for the durable consumer. Idempotent. */
  async applyFailed(paymentId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BillingUpgradeRequest);
      const request = await lockRequestByPayment(manager, paymentId);
      if (!request) return;
      // Only a request still awaiting this payment transitions — a request
      // already terminal (e.g. cancelled in the meantime) is left alone.
      if (request.status !== BILLING_UPGRADE_STATUS.PAYMENT_PROCESSING) return;

      const fromStatus = request.status;
      request.status = BILLING_UPGRADE_STATUS.PAYMENT_FAILED;
      const saved = await repo.save(request);

      await this.history.record(
        {
          requestId: saved.id,
          type: BILLING_UPGRADE_EVENT_TYPE.STATUS_CHANGED,
          fromValue: fromStatus,
          toValue: BILLING_UPGRADE_STATUS.PAYMENT_FAILED,
          note: 'Payment failed or was declined — no entitlement was applied.',
          metadata: { paymentId },
        },
        manager,
      );
    });
  }

  /** null (permanent) for one_time/unspecified; otherwise the billing period's end date. */
  private computeExpiry(billingPeriod?: string): Date | null {
    const now = new Date();
    if (billingPeriod === BILLING_UPGRADE_BILLING_PERIOD.MONTHLY) {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    }
    if (billingPeriod === BILLING_UPGRADE_BILLING_PERIOD.YEARLY) {
      const d = new Date(now);
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    }
    return null;
  }
}
