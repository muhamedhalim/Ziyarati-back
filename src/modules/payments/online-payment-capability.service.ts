import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { MerchantAccount } from '../../entities/Payments/MerchantAccount';

import { PaymentsConfig } from './payments.config';
import {
  MERCHANT_ACCOUNT_STATUS,
  ONLINE_PAYMENT_UNAVAILABLE,
  OnlinePaymentUnavailableReason,
  isProviderMerchantId,
} from './payments.constants';

export interface OnlinePaymentCapability {
  /** Can a patient pay THIS clinic online right now? */
  available: boolean;
  reason?: OnlinePaymentUnavailableReason;
  /**
   * The merchant to charge on the clinic's behalf (Tap Platform `merchant.id`).
   * Set only when the active provider routes clinic money by merchant.
   */
  settlementMerchantId?: string;
}

/**
 * The single answer to "can this clinic collect an ONLINE booking payment?".
 *
 * Booking creation, pay-link issuing, the public pay page and every charge read
 * it, so the answer cannot drift between them. The rule that mattered before
 * this existed: a booking was created PENDING_PAYMENT for a clinic that had
 * nothing it could be paid through, and a patient was handed a link that could
 * only ever fail.
 *
 *  - NOT Tap (Noop simulator / legacy Moyasar): nothing changes. Their own
 *    gating (`MerchantAccountService.assertChargeable`, the dev Noop flow)
 *    stays exactly as it was, so this adds no behaviour to a deployment that is
 *    not on Tap.
 *  - Tap: ALL of — `TAP_BOOKING_PAYMENTS_ENABLED`, platform credentials +
 *    `TAP_PLATFORM_ID`, and a clinic merchant that Tap onboarded AND a platform
 *    admin approved. Patient money is only ever routed to a merchant a human
 *    approved; it can never land in ZiyaraTech's own account (the adapter also
 *    refuses a clinic charge with no routing).
 *
 * It depends only on `PaymentsConfig` and the DataSource, so any module (the
 * appointments domain included) can use it without importing the payments
 * module — and the payments module imports the appointments' side of the
 * decision, never the reverse. Pass the caller's `manager` to read on the same
 * snapshot as the surrounding transaction.
 */
@Injectable()
export class OnlinePaymentCapabilityService {
  constructor(
    private readonly config: PaymentsConfig,
    private readonly dataSource: DataSource,
  ) {}

  /** TRUE when the booking-payment decision is governed by Tap's rules. */
  get tapGoverned(): boolean {
    return this.config.providerName === 'tap';
  }

  async resolve(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<OnlinePaymentCapability> {
    if (!this.tapGoverned) return { available: true };

    if (!this.config.tapBookingPaymentsEnabled) {
      return unavailable(ONLINE_PAYMENT_UNAVAILABLE.DISABLED);
    }
    if (!this.config.tapPlatformId || !this.config.tapSecretKey) {
      return unavailable(ONLINE_PAYMENT_UNAVAILABLE.NOT_CONFIGURED);
    }

    const account = await (manager ?? this.dataSource.manager)
      .getRepository(MerchantAccount)
      .findOne({ where: { tenant: { id: tenantId } } });

    const merchantId = account?.provider_recipient_id?.trim();
    if (
      !account ||
      account.provider !== 'tap' ||
      account.status !== MERCHANT_ACCOUNT_STATUS.APPROVED ||
      !merchantId ||
      !isProviderMerchantId(merchantId)
    ) {
      return unavailable(ONLINE_PAYMENT_UNAVAILABLE.CLINIC_NOT_ONBOARDED);
    }
    return { available: true, settlementMerchantId: merchantId };
  }
}

const unavailable = (
  reason: OnlinePaymentUnavailableReason,
): OnlinePaymentCapability => ({ available: false, reason });
