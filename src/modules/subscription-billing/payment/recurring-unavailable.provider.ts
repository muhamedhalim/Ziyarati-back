import { Injectable, Logger } from '@nestjs/common';
import {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  RefundRequest,
  RefundResult,
} from './payment-provider.interface';

/**
 * Production stand-in until recurring charges are actually enabled.
 *
 * Moyasar DOES support saved-card tokenization + recurring charges, but that
 * flow needs (a) tokenization enabled on the merchant account and (b) a stored
 * per-clinic card token captured through the client-side form — neither exists
 * yet. Until then, a LIVE deployment must not "simulate" a subscription charge:
 * the stub marking invoices PAID with no money moved is exactly the incorrect
 * financial behavior the platform must never exhibit.
 *
 * This provider fails every charge with a clear domain message instead. Once
 * tokenization is contractually enabled and tokens are stored, replace this
 * binding with a real token-charge adapter — BillingService stays untouched.
 */
@Injectable()
export class RecurringUnavailableProvider implements PaymentProvider {
  private readonly logger = new Logger('RecurringUnavailableProvider');

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.logger.warn(
      `Subscription charge for invoice ${request.invoiceId} rejected: recurring payments are not yet enabled`,
    );
    return {
      success: false,
      failureReason:
        'Subscription auto-charge is not yet enabled: it requires provider tokenization (a saved payment method). No charge was attempted.',
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.logger.warn(
      `Subscription refund for invoice ${request.invoiceId} rejected: recurring payments are not yet enabled`,
    );
    return {
      success: false,
      failureReason:
        'Subscription refunds are not available until recurring payments are enabled with the provider.',
    };
  }
}
