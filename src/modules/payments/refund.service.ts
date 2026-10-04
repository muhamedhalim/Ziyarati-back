import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, FindOptionsWhere, Repository } from 'typeorm';

import { Refund } from '../../entities/Payments/Refund';
import { Payment } from '../../entities/Payments/Payment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { PaymentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import type { GatewayRefundResult } from './providers/payment-gateway.provider.interface';
import { TransactionService } from './transaction.service';
import { RefundCompletionService, RefundCompletion } from './refund-completion.service';
import { CreateRefundDto } from './dto/create-refund.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';
import { REFUND_STATUS, TRANSACTION_TYPE } from './payments.constants';

/** Single, bounded major-units → integer-cents conversion (no float arithmetic downstream). */
const toCents = (v: number | string): number => Math.round(Number(v) * 100);
const fromCents = (c: number): number => c / 100;

const PG_UNIQUE_VIOLATION = '23505';

/**
 * A gateway's answer, as one of four outcomes. Providers that predate the
 * `status` field answer only `success`: true is a completed refund and false a
 * definitive decline, exactly as before.
 */
export function refundOutcomeOf(
  result: GatewayRefundResult,
): 'succeeded' | 'failed' | 'pending' | 'unknown' {
  if (result.status) return result.status;
  return result.success ? 'succeeded' : 'failed';
}

interface RefundIntent {
  refundId: string;
  paymentId: string;
  gatewayPaymentId?: string;
  gateway?: string;
  currency: string;
  amountC: number;
}

/**
 * Refunds — full or partial, always against an existing payment.
 *
 * Phase-1 fixes applied:
 *  - C1: idempotent via `idempotency_key` (UNIQUE per tenant) — a replay returns
 *    the existing refund, never a second gateway refund.
 *  - C3: the gateway is called OUTSIDE any DB transaction/lock (2-phase) so a slow
 *    gateway can never hold a row lock or a pooled connection.
 *  - M1/M3: the refunded total is summed in SQL (exact `numeric`) and all
 *    balance checks are done in integer cents (no float epsilons).
 *
 * Tenant-scoped via the `tenant` relation throughout.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger('RefundService');

  constructor(
    @InjectRepository(Refund)
    private readonly refunds: Repository<Refund>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
    private readonly completion: RefundCompletionService,
  ) {}

  async create(
    tenantId: string,
    dto: CreateRefundDto,
    userId?: string,
  ): Promise<Refund> {
    // C1: fast-path replay.
    if (dto.idempotencyKey) {
      const existing = await this.findByKey(tenantId, dto.idempotencyKey);
      if (existing) return existing;
    }

    // ── Phase 1: short tx — lock, validate, persist PENDING intent (NO gateway) ──
    let intent: RefundIntent;
    try {
      intent = await this.dataSource.transaction((m) =>
        this.persistIntent(m, tenantId, dto, userId),
      );
    } catch (err) {
      // C1: lost the unique race → another request already created it; return it.
      if (
        dto.idempotencyKey &&
        (err as { code?: string })?.code === PG_UNIQUE_VIOLATION
      ) {
        const existing = await this.findByKey(tenantId, dto.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }

    // ── Phase 2: gateway call OUTSIDE any tx/lock (C3) ──
    // Four outcomes, not two. A gateway with asynchronous refunds (Tap) answers
    // 'pending' — accepted, money not yet moved — and a transport error is
    // 'unknown'. Neither is a failure: booking either as FAILED would release the
    // reserved balance while the refund may still complete.
    let result: GatewayRefundResult = { success: true, status: 'succeeded' };
    if (intent.gatewayPaymentId) {
      result = await this.gateways.resolve(intent.gateway).refundPayment({
        tenantId,
        paymentId: intent.paymentId,
        // The PENDING refund row already exists (Phase 1), so its id is the
        // stable per-refund key idempotent gateways need (Tap reference.idempotent).
        refundId: intent.refundId,
        gatewayPaymentId: intent.gatewayPaymentId,
        amount: fromCents(intent.amountC),
        currency: intent.currency,
        reason: dto.reason,
      });
    }
    const outcome = refundOutcomeOf(result);

    // ── Phase 3: short tx — finalize refund + payment status from SQL sum ──
    const finished = await this.dataSource.transaction(async (m) => {
      const payment = await m.getRepository(Payment).findOne({
        where: { id: intent.paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
      }
      const refundRepo = m.getRepository(Refund);
      const refund = await refundRepo.findOneByOrFail({ id: intent.refundId });

      // A webhook or the reaper may have finished this refund while the gateway
      // call was in flight (Tap can answer the webhook before the response is
      // handled). Never apply it twice.
      if (refund.status !== REFUND_STATUS.PENDING) {
        return { refund, completion: undefined as RefundCompletion | undefined };
      }

      if (outcome === 'succeeded' || outcome === 'failed') {
        const completion = await this.completion.complete(m, {
          tenantId,
          payment,
          refund,
          outcome,
          gatewayRefundId: result.gatewayRefundId,
          failureReason: result.failureReason,
          gatewayTransactionId: intent.gatewayPaymentId,
          raw: result.raw,
        });
        return { refund, completion };
      }

      // pending | unknown: stays PENDING and keeps holding its balance. Persist the
      // provider's refund id (webhook matching, the reaper's verifyRefund) and say
      // what the gateway said in the ledger.
      if (result.gatewayRefundId && !refund.gateway_refund_id) {
        refund.gateway_refund_id = result.gatewayRefundId;
        await refundRepo.save(refund);
      }
      await this.transactions.record(
        tenantId,
        intent.paymentId,
        {
          type: TRANSACTION_TYPE.REFUND,
          amount: fromCents(intent.amountC),
          status: outcome,
          gatewayTransactionId: intent.gatewayPaymentId,
          raw: result.raw,
        },
        m,
      );
      return { refund, completion: undefined as RefundCompletion | undefined };
    });

    this.completion.emitAfterCommit(finished.completion);

    // The FAILED state is COMMITTED above, so the refusal is raised only now.
    // (It used to be thrown inside the transaction, which rolled the FAILED row
    // and its ledger entry back: a declined refund stayed PENDING for ever,
    // silently holding the balance it had reserved.)
    if (finished.completion?.status === REFUND_STATUS.FAILED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Refund was declined by the gateway',
        // Raw gateway decline text — a provider-response detail, not
        // something we've curated as client-safe. Logs only.
        internalContext: {
          reason: finished.completion.failureReason ?? result.failureReason,
          code: result.failureCode,
        },
      });
    }
    return finished.refund;
  }

  async list(tenantId: string, query: QueryRefundsDto) {
    const where: FindOptionsWhere<Refund> = { tenant: { id: tenantId } };
    if (query.paymentId) where.payment = { id: query.paymentId };
    if (query.status) where.status = query.status;

    const [data, total] = await this.refunds.findAndCount({
      where,
      relations: { payment: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async findOne(tenantId: string, id: string): Promise<Refund> {
    const refund = await this.refunds.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { payment: true },
    });
    if (!refund) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Refund not found' });
    }
    return refund;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Phase 1 body: lock the payment, validate the balance, insert a PENDING refund. */
  private async persistIntent(
    m: EntityManager,
    tenantId: string,
    dto: CreateRefundDto,
    userId?: string,
  ): Promise<RefundIntent> {
    const payment = await m.getRepository(Payment).findOne({
      where: { id: dto.paymentId, tenant: { id: tenantId } },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
    }
    if (
      payment.status !== PaymentStatus.PAID &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only paid payments can be refunded (status: ${payment.status})`,
      });
    }

    const admittedC = await this.sumAdmittedCents(m, payment.id);
    const remainingC = toCents(payment.amount) - admittedC;
    const amountC = dto.amount != null ? toCents(dto.amount) : remainingC;

    if (amountC <= 0 || amountC > remainingC) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Refund amount exceeds the remaining refundable balance',
        publicContext: { remaining: fromCents(remainingC), requested: fromCents(amountC) },
      });
    }

    const refund = await m.getRepository(Refund).save(
      m.getRepository(Refund).create({
        tenant: { id: tenantId } as Tenant,
        payment: { id: payment.id } as Payment,
        amount: fromCents(amountC),
        reason: dto.reason,
        status: REFUND_STATUS.PENDING,
        idempotency_key: dto.idempotencyKey,
        processed_by: userId ? ({ id: userId } as User) : undefined,
      }),
    );

    return {
      refundId: refund.id,
      paymentId: payment.id,
      gatewayPaymentId: payment.gateway_payment_id,
      gateway: payment.gateway,
      currency: payment.currency,
      amountC,
    };
  }

  /**
   * FND-026 / AD-01 — the ADMISSION sum: `PENDING` **and** `SUCCEEDED`, in
   * integer cents. Used only to decide whether a NEW refund fits the
   * remaining balance (`persistIntent`). A concurrent refund that already
   * reserved money by going PENDING must count against the balance even
   * before its own gateway call resolves — otherwise two concurrent refunds
   * can each see "nothing admitted yet" and both be let through. `FAILED` is
   * excluded: a failed refund releases the capacity it had reserved.
   */
  private async sumAdmittedCents(
    m: EntityManager,
    paymentId: string,
  ): Promise<number> {
    const row = await m
      .createQueryBuilder(Refund, 'r')
      .innerJoin('r.payment', 'p')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('p.id = :pid', { pid: paymentId })
      .andWhere('r.status IN (:...statuses)', {
        statuses: [REFUND_STATUS.PENDING, REFUND_STATUS.SUCCEEDED],
      })
      .getRawOne<{ sum: string }>();
    return toCents(row?.sum ?? 0);
  }

  private findByKey(tenantId: string, key: string): Promise<Refund | null> {
    return this.refunds.findOne({
      where: { tenant: { id: tenantId }, idempotency_key: key },
      relations: { payment: true },
    });
  }
}
