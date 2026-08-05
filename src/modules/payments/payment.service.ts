import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
  In,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { PaymentSucceededEvent } from '../../events/payment.events';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { PaymentFinancialsService } from './payment-financials.service';
import { MerchantAccountService } from './merchant-account.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { QueryPaymentsDto } from './dto/query-payments.dto';
import {
  DEFAULT_PAYMENT_CURRENCY,
  TRANSACTION_TYPE,
  round2,
} from './payments.constants';

/**
 * Payment lifecycle: PENDING → PAID / FAILED → (REFUNDED via RefundService).
 *
 * Tenant isolation: `payments` is tenant-scoped via the `tenant` relation, so
 * every query filters `where: { tenant: { id: tenantId } }`; the tenant is
 * always taken from the authenticated principal, never from input.
 *
 * The gateway is reached ONLY through `PaymentGatewayFactory` (provider
 * abstraction). State transitions run inside a DB transaction with a
 * pessimistic row lock to avoid races with concurrent confirms/webhooks.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger('PaymentService');

  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
    private readonly financials: PaymentFinancialsService,
    private readonly merchants: MerchantAccountService,
    private readonly emitter: EventEmitter2,
  ) {}

  async create(tenantId: string, dto: CreatePaymentDto) {
    // FND-027 / AD-02: a manual (no-appointment) payment carries neither the
    // appointment-based PENDING floor nor, usually, a client-supplied key —
    // the "New payment" UI never sends one. When the client supplies none on
    // that path, derive one deterministically (tenant + customer + amount +
    // a coarse time bucket) so the existing per-tenant unique index still
    // catches a double-submit. Appointment-based payments keep relying on
    // their own floor (the partial unique index + the "already paid"/"reuse
    // PENDING" checks in resolveBookingPrice) and are left untouched.
    const idempotencyKey =
      dto.idempotencyKey ??
      (!dto.appointmentId
        ? this.deriveManualIdempotencyKey(tenantId, dto)
        : undefined);

    // Idempotent create: a retry with the same key returns the existing payment.
    if (idempotencyKey) {
      const existing = await this.payments.findOne({
        where: { tenant: { id: tenantId }, idempotency_key: idempotencyKey },
      });
      if (existing) {
        return { payment: existing, status: existing.status, redirectUrl: undefined };
      }
    }

    // Marketplace gate: a clinic whose merchant account is not APPROVED cannot
    // collect live money (no-op in the dev/test Noop flow).
    await this.merchants.assertChargeable(tenantId);

    // Server-authoritative pricing: a payment that settles a booking takes its
    // amount/currency from the appointment row — NEVER from the client. A
    // client-supplied figure is only accepted as a cross-check.
    const authoritative = await this.resolveBookingPrice(tenantId, dto);

    // Refresh/double-click safety: an in-flight PENDING attempt for the same
    // booking is returned (with its stored hosted-page URL) — never re-charged.
    if (authoritative?.reusable) {
      const reused = authoritative.reusable;
      return {
        payment: reused,
        status: reused.status,
        redirectUrl: reused.metadata?.redirect_url as string | undefined,
      };
    }

    const amount = authoritative?.amount ?? dto.amount!;
    const currency =
      authoritative?.currency ?? dto.currency ?? DEFAULT_PAYMENT_CURRENCY;
    const customerId = dto.customerId ?? authoritative?.customerId;

    const provider = this.gateways.resolve(dto.gateway);

    // Marketplace split context (null unless the feature is contractually
    // enabled AND the clinic is approved with a gateway recipient id).
    const split = await this.merchants.splitContext(tenantId);

    let payment: Payment;
    try {
      payment = await this.payments.save(
        this.payments.create({
          tenant: { id: tenantId } as Tenant,
          branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
          appointment: dto.appointmentId
            ? ({ id: dto.appointmentId } as Appointment)
            : undefined,
          customer: customerId ? ({ id: customerId } as Customer) : undefined,
          amount,
          currency,
          status: PaymentStatus.PENDING,
          gateway: provider.name,
          idempotency_key: idempotencyKey,
          sub_merchant_id: split?.recipientId,
        }),
      );
    } catch (err) {
      const isUniqueViolation = (err as { code?: string })?.code === '23505';

      // Lost the one-PENDING-per-appointment unique race (double click /
      // concurrent tabs): return the winner instead of a second charge.
      if (dto.appointmentId && isUniqueViolation) {
        const winner = await this.payments.findOne({
          where: {
            tenant: { id: tenantId },
            appointment: { id: dto.appointmentId },
            status: PaymentStatus.PENDING,
          },
        });
        if (winner) {
          return {
            payment: winner,
            status: winner.status,
            redirectUrl: winner.metadata?.redirect_url as string | undefined,
          };
        }
      }

      // FND-027: lost the idempotency-key race (concurrent manual double
      // submit, derived or client-supplied) — same recovery pattern as
      // RefundService.create's idempotencyKey race.
      if (idempotencyKey && isUniqueViolation) {
        const winner = await this.payments.findOne({
          where: { tenant: { id: tenantId }, idempotency_key: idempotencyKey },
        });
        if (winner) {
          return {
            payment: winner,
            status: winner.status,
            redirectUrl: winner.metadata?.redirect_url as string | undefined,
          };
        }
      }
      throw err;
    }

    let redirectUrl: string | undefined;
    try {
      const result = await provider.createPayment({
        tenantId,
        paymentId: payment.id,
        amount: Number(payment.amount),
        currency,
        description: dto.description,
        callbackUrl: dto.callbackUrl,
        metadata: { tenantId, paymentId: payment.id },
        idempotencyKey: dto.idempotencyKey,
        // Single split routing the clinic's net (gross − platform fee) to its
        // gateway recipient; the platform fee stays with the platform account.
        splits: split
          ? [
              {
                recipientId: split.recipientId,
                amount: round2(
                  Number(payment.amount) -
                    this.financials.platformFeeFor(Number(payment.amount)),
                ),
                reference: payment.id,
                refundable: true,
              },
            ]
          : undefined,
      });
      redirectUrl = result.redirectUrl;

      if (result.gatewayPaymentId) {
        payment.gateway_payment_id = result.gatewayPaymentId;
      }
      // Some gateways capture immediately; reflect that without a second call.
      if (result.status === 'paid') {
        payment.status = PaymentStatus.PAID;
        payment.paid_at = new Date();
        // Freeze the fee breakdown (gateway fee from raw if reported).
        this.financials.applyOnPaid(payment, this.financials.extractFromRaw(result.raw));
      } else if (result.status === 'failed') {
        payment.status = PaymentStatus.FAILED;
      }

      // Persist the hosted-page URL so a refresh/retry can REUSE the active
      // payment attempt instead of creating a second gateway charge.
      if (redirectUrl) {
        payment.metadata = { ...(payment.metadata ?? {}), redirect_url: redirectUrl };
      }

      // Ledger atomicity: the status change and its CHARGE audit row commit
      // together — never a status change without a transaction record.
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(Payment).save(payment);
        await this.transactions.record(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.CHARGE,
            amount: Number(payment.amount),
            status: result.status,
            gatewayTransactionId: result.gatewayPaymentId,
            raw: result.raw,
          },
          manager,
        );
      });
    } catch (err) {
      // Leave the payment PENDING; confirm() or a webhook can still resolve it.
      this.logger.error(
        `Gateway createPayment failed for ${payment.id}`,
        err as Error,
      );
    }

    return { payment, status: payment.status, redirectUrl };
  }

  /**
   * FND-027 / AD-02 — deterministic idempotency key for a manual (no-
   * appointment) payment when the client supplies none: tenant + customer +
   * amount + a 1-minute time bucket (same coarse-bucket pattern as
   * `queue.service.ts#enqueueUsageReportRun`). A double-click collides
   * (deduplicated); a genuinely later distinct payment (next bucket, or a
   * different amount/customer) does not.
   *
   * The existing `idempotency_key` unique constraint is GLOBAL (not
   * tenant-scoped — `UQ_59dcef70bd19850783c84f840e5` on `payments`, unlike
   * `refunds`' tenant-scoped `uq_refund_idem`), so the tenant id is embedded
   * directly in the derived string: this makes the key self-namespaced and
   * collision-safe regardless of that constraint shape, without requiring a
   * schema change.
   */
  private deriveManualIdempotencyKey(
    tenantId: string,
    dto: CreatePaymentDto,
  ): string {
    const amountKey = dto.amount != null ? Math.round(dto.amount * 100) : 'na';
    const customerKey = dto.customerId ?? 'anon';
    const minuteBucket = Math.floor(Date.now() / 60_000);
    return `mp:${tenantId}:${customerKey}:${amountKey}:${minuteBucket}`;
  }

  /**
   * Booking-linked payments: resolve the authoritative price from the DATABASE.
   *
   * - The appointment must exist in the caller's tenant with a positive total.
   * - A client-supplied amount/currency is accepted only as a cross-check: any
   *   mismatch is rejected (anti amount/currency tampering) — the booking price
   *   is never adjusted to match what a client offers to pay.
   * - A payment with no appointment keeps the explicit-amount flow (staff POS
   *   style, `payments.manage` guarded), which then REQUIRES an amount.
   *
   * Returns null for non-booking payments.
   */
  private async resolveBookingPrice(
    tenantId: string,
    dto: CreatePaymentDto,
  ): Promise<{
    amount: number;
    currency: string;
    customerId?: string;
    /** An in-flight PENDING attempt to reuse instead of charging again. */
    reusable?: Payment;
  } | null> {
    if (!dto.appointmentId) {
      if (dto.amount == null) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'amount is required for a payment not linked to an appointment',
        });
      }
      return null;
    }

    const appointment = await this.dataSource.getRepository(Appointment).findOne({
      where: { id: dto.appointmentId, tenant: { id: tenantId } },
      relations: { customer: true },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Appointment not found' });
    }

    const amount = round2(Number(appointment.total_amount ?? 0));
    if (!(amount > 0)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Appointment has no payable total amount',
      });
    }
    const currency = appointment.currency || DEFAULT_PAYMENT_CURRENCY;

    if (
      dto.amount != null &&
      Math.round(Number(dto.amount) * 100) !== Math.round(amount * 100)
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Provided amount does not match the booking price. The booking price is read from the server.',
        publicContext: { expected: amount, provided: dto.amount },
      });
    }
    if (dto.currency && dto.currency.toUpperCase() !== currency.toUpperCase()) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'Provided currency does not match the booking currency. The booking currency is read from the server.',
        publicContext: { expected: currency, provided: dto.currency },
      });
    }

    // One financial obligation → one live charge. ANY existing PAID (or
    // partially refunded) payment blocks a second charge — regardless of later
    // FAILED attempts; an in-flight PENDING attempt is RETURNED for reuse
    // instead of creating a new gateway charge. (Backed by a partial UNIQUE
    // index on payments(appointmentId) WHERE status='PENDING' so a concurrent
    // race cannot slip a duplicate through.)
    const live = await this.payments.find({
      where: {
        tenant: { id: tenantId },
        appointment: { id: dto.appointmentId },
        status: In([
          PaymentStatus.PAID,
          PaymentStatus.PARTIALLY_REFUNDED,
          PaymentStatus.PENDING,
        ]),
      },
      order: { created_at: 'DESC' },
    });
    const paid = live.find((p) => p.status !== PaymentStatus.PENDING);
    if (paid) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This booking is already paid',
        publicContext: { paymentId: paid.id },
      });
    }

    return {
      amount,
      currency,
      customerId: appointment.customer?.id,
      reusable: live.find((p) => p.status === PaymentStatus.PENDING),
    };
  }

  async confirm(tenantId: string, id: string, dto: ConfirmPaymentDto) {
    // ── Phase 1: short tx — lock, idempotent checks, resolve the gateway id.
    // (The gateway is NOT called here, so the row lock is held only briefly.)
    const prep = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id, tenant: { id: tenantId } },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
      }

      // Idempotent: already settled → nothing to verify.
      if (payment.status === PaymentStatus.PAID) {
        return { settled: payment };
      }
      if (
        payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Payment in status "${payment.status}" cannot be confirmed`,
        });
      }

      if (dto.gatewayPaymentId && !payment.gateway_payment_id) {
        payment.gateway_payment_id = dto.gatewayPaymentId;
        await repo.save(payment);
      }
      if (!payment.gateway_payment_id) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'No gateway payment to verify for this payment',
        });
      }
      return {
        gatewayPaymentId: payment.gateway_payment_id,
        gateway: payment.gateway,
        amount: Number(payment.amount),
      };
    });

    if ('settled' in prep) return prep.settled;

    // ── Phase 2: gateway verify OUTSIDE any tx/lock (C3).
    const result = await this.gateways
      .resolve(prep.gateway)
      .verifyPayment(prep.gatewayPaymentId);

    // ── Phase 3: short tx — re-lock and finalize idempotently.
    const { payment: finalized, becamePaid } = await this.dataSource.transaction(
      async (manager) => {
        const repo = manager.getRepository(Payment);
        const payment = await repo.findOne({
          where: { id, tenant: { id: tenantId } },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment) {
          throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
        }

        await this.transactions.record(
          tenantId,
          payment.id,
          {
            type: TRANSACTION_TYPE.VERIFY,
            amount: Number(payment.amount),
            status: result.status,
            gatewayTransactionId: prep.gatewayPaymentId,
            raw: result.raw,
          },
          manager,
        );

        // A webhook may have settled it between phases — don't regress a terminal state.
        if (payment.status === PaymentStatus.PAID) {
          return { payment, becamePaid: false };
        }
        if (result.status === 'paid') {
          // Anti under/over-payment & amount tampering: when the gateway reports
          // what it actually captured, it MUST match our expected amount/currency
          // before we book it PAID. No-op when the provider can't report it, so the
          // Noop/dev flow is unaffected.
          this.assertCapturedMatches(payment, result);
          payment.status = PaymentStatus.PAID;
          payment.paid_at = new Date();
          this.financials.applyOnPaid(payment, this.financials.extractFromRaw(result.raw));
          return { payment: await repo.save(payment), becamePaid: true };
        }
        if (result.status === 'failed') {
          payment.status = PaymentStatus.FAILED;
        }
        return { payment: await repo.save(payment), becamePaid: false };
      },
    );

    // Same domain event the webhook path emits, AFTER the commit — so booking
    // confirmation / notifications fire exactly once whichever signal lands
    // first (the webhook path skips its emit when the status is already PAID).
    if (becamePaid) {
      const withRels = await this.payments.findOne({
        where: { id: finalized.id },
        relations: { customer: true, appointment: true },
      });
      this.emitter.emit(
        PaymentSucceededEvent.eventName,
        new PaymentSucceededEvent(
          tenantId,
          finalized.id,
          Number(finalized.amount),
          finalized.currency,
          withRels?.customer?.id,
          withRels?.appointment?.id,
        ),
      );
    }
    return finalized;
  }

  /**
   * Reconcile the gateway-captured amount/currency against our expected payment.
   * Throws (leaving the payment PENDING for review) on any mismatch — stops an
   * underpaid / overpaid / amount-tampered gateway charge from being booked PAID
   * (e.g. a client-created charge linked via `confirm` for a different amount).
   * A no-op when the provider does not report the captured figures.
   */
  private assertCapturedMatches(
    payment: Payment,
    result: { capturedMinorUnits?: number; capturedCurrency?: string },
  ): void {
    const expectedC = Math.round(Number(payment.amount) * 100);
    if (
      result.capturedMinorUnits != null &&
      result.capturedMinorUnits !== expectedC
    ) {
      this.logger.error(
        `Payment ${payment.id} confirm rejected: captured ${result.capturedMinorUnits} ≠ expected ${expectedC} minor units`,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Captured amount does not match the expected payment amount',
        publicContext: {
          expectedMinorUnits: expectedC,
          capturedMinorUnits: result.capturedMinorUnits,
        },
      });
    }
    if (
      result.capturedCurrency &&
      result.capturedCurrency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      this.logger.error(
        `Payment ${payment.id} confirm rejected: captured currency ${result.capturedCurrency} ≠ expected ${payment.currency}`,
      );
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Captured currency does not match the expected payment currency',
        publicContext: {
          expected: payment.currency,
          captured: result.capturedCurrency,
        },
      });
    }
  }

  async getStatus(tenantId: string, id: string) {
    const payment = await this.findOne(tenantId, id);
    return {
      id: payment.id,
      status: payment.status,
      settlement_status: payment.settlement_status,
      amount: payment.amount,
      currency: payment.currency,
      gateway: payment.gateway,
      gateway_payment_id: payment.gateway_payment_id,
      paid_at: payment.paid_at,
    };
  }

  async list(tenantId: string, query: QueryPaymentsDto) {
    const where: FindOptionsWhere<Payment> = { tenant: { id: tenantId } };
    if (query.status) where.status = query.status;
    if (query.settlementStatus) where.settlement_status = query.settlementStatus;
    if (query.customerId) where.customer = { id: query.customerId };
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    const [data, total] = await this.payments.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: data.map((p) => this.sanitizeForClient(p)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async findOne(tenantId: string, id: string): Promise<Payment> {
    const payment = await this.payments.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!payment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
    }
    return this.sanitizeForClient(payment);
  }

  /**
   * FND-030 — `failure_reason` is populated from RAW, unvalidated gateway
   * webhook text (`payment-webhook.service.ts`: `event.data?.source?.message`
   * verbatim) — never safe to return to a client as-is (could contain
   * card-adjacent fragments, internal gateway jargon, or anything the
   * provider chose to put there). Sanitized VALUE only, on READ — the field
   * name/type are unchanged, and the raw text is never touched in the
   * database (kept for support/reconciliation, e.g.
   * `payment-reconciliation.service.ts`/`marketplace-finance.service.ts`,
   * both internal-only reads).
   */
  private sanitizeForClient(payment: Payment): Payment {
    if (!payment.failure_reason) return payment;
    return { ...payment, failure_reason: 'Payment was declined by the provider.' };
  }
}
