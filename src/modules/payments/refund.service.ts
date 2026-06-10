import { Injectable } from '@nestjs/common';
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
import { CreateRefundDto } from './dto/create-refund.dto';
import { QueryRefundsDto } from './dto/query-refunds.dto';
import { REFUND_STATUS, TRANSACTION_TYPE, round2 } from './payments.constants';

/**
 * Refunds (`refunds`) — full or partial, always against an existing payment.
 *
 * Tenant-scoped via the `tenant` relation. The refund runs inside a DB
 * transaction with a pessimistic lock on the payment so concurrent refunds
 * cannot over-refund. The gateway is reached only through the provider
 * abstraction; a provider decline rolls the whole thing back (no phantom rows).
 */
@Injectable()
export class RefundService {
  constructor(
    @InjectRepository(Refund)
    private readonly refunds: Repository<Refund>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly gateways: PaymentGatewayFactory,
    private readonly transactions: TransactionService,
  ) {}

  async create(
    tenantId: string,
    dto: CreateRefundDto,
    userId?: string,
  ): Promise<Refund> {
    // Ownership / state pre-check (tenant-scoped, no lock).
    const owner = await this.payments.findOne({
      where: { id: dto.paymentId, tenant: { id: tenantId } },
    });
    if (!owner) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
    }
    if (
      owner.status !== PaymentStatus.PAID &&
      owner.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only paid payments can be refunded (status: ${owner.status})`,
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const refundRepo = manager.getRepository(Refund);

      const payment = await paymentRepo.findOne({
        where: { id: owner.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
      }

      const paymentAmount = Number(payment.amount);
      const alreadyRefunded = await this.sumSucceededRefunds(manager, payment.id);
      const remaining = round2(paymentAmount - alreadyRefunded);
      const amount = dto.amount != null ? round2(Number(dto.amount)) : remaining;

      if (amount <= 0 || amount > remaining + 1e-9) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Refund amount ${amount} exceeds the remaining refundable balance ${remaining}`,
          context: { remaining, requested: amount },
        });
      }

      // Gateway refund (only if there is a gateway payment to refund against).
      let providerRaw: Record<string, any> | undefined;
      if (payment.gateway_payment_id) {
        const provider = this.gateways.resolve(payment.gateway);
        const result = await provider.refundPayment({
          tenantId,
          paymentId: payment.id,
          gatewayPaymentId: payment.gateway_payment_id,
          amount,
          currency: payment.currency,
          reason: dto.reason,
        });
        if (!result.success) {
          // Roll back entirely — no refund/transaction rows persisted.
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: 'Refund was declined by the gateway',
            context: { reason: result.failureReason },
          });
        }
        providerRaw = result.raw;
      }

      const refund = await refundRepo.save(
        refundRepo.create({
          tenant: { id: tenantId } as Tenant,
          payment: { id: payment.id } as Payment,
          amount,
          reason: dto.reason,
          status: REFUND_STATUS.SUCCEEDED,
          processed_by: userId ? ({ id: userId } as User) : undefined,
        }),
      );

      await this.transactions.record(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.REFUND,
          amount,
          status: REFUND_STATUS.SUCCEEDED.toLowerCase(),
          gatewayTransactionId: payment.gateway_payment_id,
          raw: providerRaw,
        },
        manager,
      );

      // Advance payment status based on cumulative refunded total.
      const refundedTotal = round2(alreadyRefunded + amount);
      payment.status =
        refundedTotal >= paymentAmount - 1e-9
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;
      await paymentRepo.save(payment);

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

  /**
   * Sum of succeeded refunds for a payment. Uses the relation (no raw FK SQL);
   * refund counts per payment are tiny, so summing in memory is fine.
   */
  private async sumSucceededRefunds(
    manager: EntityManager,
    paymentId: string,
  ): Promise<number> {
    const rows = await manager.getRepository(Refund).find({
      where: { payment: { id: paymentId }, status: REFUND_STATUS.SUCCEEDED },
    });
    return round2(rows.reduce((sum, r) => sum + Number(r.amount), 0));
  }
}
