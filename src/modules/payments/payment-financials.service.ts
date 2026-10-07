import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Payment } from '../../entities/Payments/Payment';
import { round2 } from './payments.constants';

export interface ApplyFeesInput {
  /** Gateway fee in MAJOR units, when the provider reports it. */
  gatewayFee?: number;
  paymentMethod?: string;
  merchantId?: string;
  subMerchantId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Freezes the per-payment financial breakdown at the moment of capture.
 *
 * Gross is `payment.amount`. The platform commission is config-driven
 * (`PLATFORM_FEE_PERCENT` + `PLATFORM_FEE_FIXED`, both default 0). The gateway
 * fee comes from the provider when available (reported by the adapter), else
 * 0. `net = gross − gateway_fee − platform_fee`. These figures are PERSISTED so
 * later fee-schedule changes never retroactively alter historical records.
 */
@Injectable()
export class PaymentFinancialsService {
  private readonly platformFeePercent: number;
  private readonly platformFeeFixed: number;

  constructor(config: ConfigService) {
    this.platformFeePercent =
      Number(config.get('PLATFORM_FEE_PERCENT') ?? 0) || 0;
    this.platformFeeFixed = Number(config.get('PLATFORM_FEE_FIXED') ?? 0) || 0;
  }

  platformFeeFor(gross: number): number {
    return round2(gross * (this.platformFeePercent / 100) + this.platformFeeFixed);
  }

  /**
   * Mutates the (PAID) payment with frozen fee figures. The caller persists it
   * inside its own transaction. Idempotent: recomputing yields the same values.
   */
  applyOnPaid(payment: Payment, input: ApplyFeesInput = {}): void {
    const gross = round2(Number(payment.amount));
    const gatewayFee = round2(
      input.gatewayFee != null ? input.gatewayFee : Number(payment.gateway_fee) || 0,
    );
    const platformFee = this.platformFeeFor(gross);

    payment.gateway_fee = gatewayFee;
    payment.platform_fee = platformFee;
    payment.net_amount = round2(gross - gatewayFee - platformFee);

    // A fee the gateway REPORTED at capture is final. When it reported none
    // (a Tap charge carries no fee), the figures above are provisional — the
    // `net = gross` default — and stay marked so until reconciliation fills in
    // the real fee. Never overwritten once stamped: a later re-application of
    // the same capture must not make a final figure look newer.
    if (input.gatewayFee != null && !payment.fees_reconciled_at) {
      payment.fees_reconciled_at = new Date();
    }

    if (input.paymentMethod && !payment.payment_method) {
      payment.payment_method = input.paymentMethod;
    }
    if (input.merchantId && !payment.merchant_id) {
      payment.merchant_id = input.merchantId;
    }
    if (input.subMerchantId && !payment.sub_merchant_id) {
      payment.sub_merchant_id = input.subMerchantId;
    }
    if (input.metadata) {
      payment.metadata = { ...(payment.metadata ?? {}), ...input.metadata };
    }
  }
}
