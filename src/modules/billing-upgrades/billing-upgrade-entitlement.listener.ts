import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';

import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import {
  PAYMENT_EVENT,
  PaymentFailedEvent,
  PaymentSucceededEvent,
} from '../../events/payment.events';

import { FeatureFlagService } from '../subscription-billing/feature-flag.service';
import { TenantUsageLimitOverrideService } from '../subscription-billing/tenant-usage-limit-override.service';

import { BillingUpgradeEventService } from './billing-upgrade-event.service';
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

  @OnEvent(PAYMENT_EVENT.SUCCEEDED)
  async onPaymentSucceeded(event: PaymentSucceededEvent): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(BillingUpgradeRequest);
        const request = await repo.findOne({
          where: { payment: { id: event.paymentId } },
          relations: { tenant: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (!request) return; // not a billing-upgrade payment

        // Idempotent: already applied (this is a duplicate/re-delivered event).
        if (request.status === BILLING_UPGRADE_STATUS.COMPLETED) return;

        if (request.type === BILLING_UPGRADE_TYPE.FEATURE && request.feature_key) {
          await this.featureFlags.set(request.tenant.id, request.feature_key, true, manager);
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
            metadata: { paymentId: event.paymentId },
          },
          manager,
        );
      });
    } catch (err) {
      this.logger.error(
        `Failed to apply entitlement for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(PAYMENT_EVENT.FAILED)
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(BillingUpgradeRequest);
        const request = await repo.findOne({
          where: { payment: { id: event.paymentId } },
          lock: { mode: 'pessimistic_write' },
        });
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
            metadata: { paymentId: event.paymentId },
          },
          manager,
        );
      });
    } catch (err) {
      this.logger.error(
        `Failed to record payment failure for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
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
