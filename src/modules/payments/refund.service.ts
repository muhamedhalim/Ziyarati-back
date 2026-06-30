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
import { TransactionService } from './transaction.service';
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { CreateRefundDto } from './dto/create-refund.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';
import { REFUND_STATUS, TRANSACTION_TYPE } from './payments.constants';

/** Single, bounded major-units → integer-cents conversion (no float arithmetic downstream). */
const toCents = (v: number | string): number => Math.round(Number(v) * 100);
const fromCents = (c: number): number => c / 100;

const PG_UNIQUE_VIOLATION = '23505';

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
    private readonly adjustments: SettlementAdjustmentService,
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
    let raw: Record<string, any> | undefined;
    let ok = true;
    let failureReason: string | undefined;
    let gatewayRefundId: string | undefined;
    if (intent.gatewayPaymentId) {
      const result = await this.gateways.resolve(intent.gateway).refundPayment({
        tenantId,
        paymentId: intent.paymentId,
        gatewayPaymentId: intent.gatewayPaymentId,
        amount: fromCents(intent.amountC),
        currency: intent.currency,
        reason: dto.reason,
      });
      ok = result.success;
      raw = result.raw;
      failureReason = result.failureReason;
      gatewayRefundId = result.gatewayRefundId;
    }

    // ── Phase 3: short tx — finalize refund + payment status from SQL sum ──
    return this.dataSource.transaction(async (m) => {
      const payment = await m.getRepository(Payment).findOne({
        where: { id: intent.paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      const refundRepo = m.getRepository(Refund);
      const refund = await refundRepo.findOneByOrFail({ id: intent.refundId });

      refund.status = ok ? REFUND_STATUS.SUCCEEDED : REFUND_STATUS.FAILED;
      // Persist the provider refund id for traceability + cross-checking against
      // refund webhooks (H2 reconciliation).
      if (gatewayRefundId) refund.gateway_refund_id = gatewayRefundId;
      await refundRepo.save(refund);

      await this.transactions.record(
        tenantId,
        intent.paymentId,
        {
          type: TRANSACTION_TYPE.REFUND,
          amount: fromCents(intent.amountC),
          status: refund.status.toLowerCase(),
          gatewayTransactionId: intent.gatewayPaymentId,
          raw,
        },
        m,
      );

      if (!ok) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Refund was declined by the gateway',
          context: { reason: failureReason },
        });
      }

      if (payment) {
        // R1 clawback: if this payment was already claimed/settled, the refund
        // can't mutate that batch — record an adjustment to net out of the next.
        await this.adjustments.recordClawbackIfSettled(
          m,
          tenantId,
          payment.id,
          payment.settlement_status,
          intent.amountC,
          refund.id,
        );

        const refundedC = await this.sumSucceededCents(m, payment.id);
        const fullyRefunded = refundedC >= toCents(payment.amount);
        payment.status = fullyRefunded
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;
        // Denormalise refund aggregates for the admin financial dashboard.
        payment.refunded_amount = fromCents(refundedC);
        payment.refund_status = fullyRefunded ? 'FULL' : 'PARTIAL';
        payment.refunded_at = new Date();
        await m.getRepository(Payment).save(payment);
      }

      return refund;
    });
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

    const refundedC = await this.sumSucceededCents(m, payment.id);
    const remainingC = toCents(payment.amount) - refundedC;
    const amountC = dto.amount != null ? toCents(dto.amount) : remainingC;

    if (amountC <= 0 || amountC > remainingC) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Refund amount exceeds the remaining refundable balance',
        context: { remaining: fromCents(remainingC), requested: fromCents(amountC) },
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

  /** Exact sum (SQL `numeric`) of succeeded refunds for a payment, in integer cents. */
  private async sumSucceededCents(
    m: EntityManager,
    paymentId: string,
  ): Promise<number> {
    const row = await m
      .createQueryBuilder(Refund, 'r')
      .innerJoin('r.payment', 'p')
      .select('COALESCE(SUM(r.amount), 0)', 'sum')
      .where('p.id = :pid', { pid: paymentId })
      .andWhere('r.status = :s', { s: REFUND_STATUS.SUCCEEDED })
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
