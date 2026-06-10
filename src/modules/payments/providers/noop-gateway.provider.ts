import { Injectable, Logger } from '@nestjs/common';

import {
  GatewayCreatePaymentRequest,
  GatewayPaymentResult,
  GatewayRefundRequest,
  GatewayRefundResult,
  PaymentGatewayProvider,
} from './payment-gateway.provider.interface';

/**
 * Default no-op gateway provider — the ultimate fallback.
 *
 * It simulates a successful create/verify/refund so the entire payment flow is
 * runnable end-to-end without a live gateway (matching the project rule that all
 * external providers are Noop until real integrations are switched on). Selected
 * by `PaymentGatewayFactory` whenever no configured real provider supports the
 * requested gateway.
 */
@Injectable()
export class NoopGatewayProvider implements PaymentGatewayProvider {
  readonly name = 'noop';
  private readonly logger = new Logger('NoopGatewayProvider');

  /** The fallback supports everything. */
  supports(): boolean {
    return true;
  }

  async createPayment(
    request: GatewayCreatePaymentRequest,
  ): Promise<GatewayPaymentResult> {
    this.logger.log(
      `[noop] create ${request.amount} ${request.currency} for payment ${request.paymentId}`,
    );
    return {
      success: true,
      gatewayPaymentId: `noop_pay_${request.paymentId}`,
      status: 'pending',
      raw: { provider: 'noop', simulated: true, paymentId: request.paymentId },
    };
  }

  async verifyPayment(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
    this.logger.log(`[noop] verify ${gatewayPaymentId} → paid (simulated)`);
    return {
      success: true,
      gatewayPaymentId,
      status: 'paid',
      raw: { provider: 'noop', simulated: true, gatewayPaymentId },
    };
  }

  async refundPayment(
    request: GatewayRefundRequest,
  ): Promise<GatewayRefundResult> {
    this.logger.log(
      `[noop] refund ${request.amount} ${request.currency} for payment ${request.paymentId}`,
    );
    return {
      success: true,
      gatewayRefundId: `noop_rf_${request.paymentId}`,
      raw: { provider: 'noop', simulated: true, paymentId: request.paymentId },
    };
  }
}
