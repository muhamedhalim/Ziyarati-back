import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { MoyasarWebhookVerifier } from './webhooks/moyasar-webhook.verifier';
import { MoyasarWebhookEvent } from './webhooks/moyasar-webhook.types';
import { TransactionService } from './transaction.service';
import { TRANSACTION_TYPE } from './payments.constants';

type TargetStatus = 'paid' | 'failed' | 'refunded' | 'pending';

export interface WebhookResult {
  accepted: boolean;
  matched?: boolean;
  deduplicated?: boolean;
  status?: PaymentStatus;
}

/**
 * Moyasar webhook orchestration — the platform-side ingestion seam.
 *
 * Flow (per the integration contract):
 *   1. Authenticate via the shared secret (MoyasarWebhookVerifier) — never trust
 *      the body for identity.
 *   2. De-duplicate on the provider event id (idempotent — safe to redeliver).
 *   3. Resolve OUR payment from `gateway_payment_id`; the tenant comes from that
 *      payment row, NEVER from the webhook body (no cross-tenant exposure).
 *   4. Apply the state change inside a locked DB transaction and log the raw
 *      event on `transactions` for audit/debug.
 *
 * Unknown / unmatched events are accepted (200) so the provider does not retry
 * storm; they are logged for investigation.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger('PaymentWebhookService');

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly verifier: MoyasarWebhookVerifier,
    private readonly transactions: TransactionService,
  ) {}

  async handleMoyasar(
    event: MoyasarWebhookEvent,
    headerToken?: string,
  ): Promise<WebhookResult> {
    // 1. Authenticate (header token preferred, body secret_token as fallback).
    const token = headerToken ?? event?.secret_token;
    if (!this.verifier.verify(token)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Invalid webhook signature',
      });
    }

    // 2. Idempotency on the provider event id.
    const eventId = event?.id;
    if (
      eventId &&
      (await this.transactions.existsByGatewayEvent(
        eventId,
        TRANSACTION_TYPE.WEBHOOK,
      ))
    ) {
      return { accepted: true, deduplicated: true };
    }

    // 3. Resolve our payment from the gateway payment id (tenant comes from it).
    const gatewayPaymentId = event?.data?.id;
    if (!gatewayPaymentId) {
      this.logger.warn('Moyasar webhook without data.id — ignored');
      return { accepted: true, matched: false };
    }

    const owner = await this.payments.findOne({
      where: { gateway_payment_id: gatewayPaymentId },
      relations: { tenant: true },
    });
    if (!owner || !owner.tenant) {
      this.logger.warn(
        `Moyasar webhook for unknown gateway payment ${gatewayPaymentId}`,
      );
      return { accepted: true, matched: false };
    }

    const tenantId = owner.tenant.id;
    const target = this.mapEvent(event);

    // 4. Apply state idempotently under a row lock.
    const finalStatus = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return owner.status;

      // Always log the raw event (gateway_transaction_id = eventId → dedup key).
      await this.transactions.record(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.WEBHOOK,
          amount: Number(payment.amount),
          status: event?.type ?? target,
          gatewayTransactionId: eventId,
          raw: event as Record<string, any>,
        },
        manager,
      );

      let changed = false;
      if (target === 'paid' && payment.status !== PaymentStatus.PAID) {
        payment.status = PaymentStatus.PAID;
        payment.paid_at = new Date();
        changed = true;
      } else if (
        target === 'failed' &&
        payment.status === PaymentStatus.PENDING
      ) {
        payment.status = PaymentStatus.FAILED;
        changed = true;
      } else if (
        target === 'refunded' &&
        payment.status !== PaymentStatus.REFUNDED
      ) {
        payment.status = PaymentStatus.REFUNDED;
        changed = true;
      }

      if (changed) await repo.save(payment);
      return payment.status;
    });

    return { accepted: true, matched: true, status: finalStatus };
  }

  /** Normalize a Moyasar event/status into our target transition. */
  private mapEvent(event: MoyasarWebhookEvent): TargetStatus {
    const type = (event?.type ?? '').toLowerCase();
    if (type.includes('refund')) return 'refunded';
    if (type.includes('paid') || type.includes('captur')) return 'paid';
    if (type.includes('fail') || type.includes('void')) return 'failed';

    const status = (event?.data?.status ?? '').toLowerCase();
    if (status === 'paid' || status === 'captured' || status === 'authorized') {
      return 'paid';
    }
    if (status === 'failed' || status === 'voided') return 'failed';
    if (status === 'refunded') return 'refunded';
    return 'pending';
  }
}
