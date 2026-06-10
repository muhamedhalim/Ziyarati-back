import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
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

import { PaymentGatewayFactory } from './providers/payment-gateway.factory';
import { TransactionService } from './transaction.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { QueryPaymentsDto } from './dto/query-payments.dto';
import { DEFAULT_PAYMENT_CURRENCY, TRANSACTION_TYPE } from './payments.constants';

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
  ) {}

  async create(tenantId: string, dto: CreatePaymentDto) {
    const currency = dto.currency ?? DEFAULT_PAYMENT_CURRENCY;

    // Idempotent create: a retry with the same key returns the existing payment.
    if (dto.idempotencyKey) {
      const existing = await this.payments.findOne({
        where: { tenant: { id: tenantId }, idempotency_key: dto.idempotencyKey },
      });
      if (existing) {
        return { payment: existing, status: existing.status, redirectUrl: undefined };
      }
    }

    const provider = this.gateways.resolve(dto.gateway);

    const payment = await this.payments.save(
      this.payments.create({
        tenant: { id: tenantId } as Tenant,
        branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
        appointment: dto.appointmentId
          ? ({ id: dto.appointmentId } as Appointment)
          : undefined,
        customer: dto.customerId ? ({ id: dto.customerId } as Customer) : undefined,
        amount: dto.amount,
        currency,
        status: PaymentStatus.PENDING,
        gateway: provider.name,
        idempotency_key: dto.idempotencyKey,
      }),
    );

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
      });
      redirectUrl = result.redirectUrl;

      if (result.gatewayPaymentId) {
        payment.gateway_payment_id = result.gatewayPaymentId;
      }
      // Some gateways capture immediately; reflect that without a second call.
      if (result.status === 'paid') {
        payment.status = PaymentStatus.PAID;
        payment.paid_at = new Date();
      } else if (result.status === 'failed') {
        payment.status = PaymentStatus.FAILED;
      }
      await this.payments.save(payment);

      await this.transactions.record(tenantId, payment.id, {
        type: TRANSACTION_TYPE.CHARGE,
        amount: Number(payment.amount),
        status: result.status,
        gatewayTransactionId: result.gatewayPaymentId,
        raw: result.raw,
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

  async confirm(tenantId: string, id: string, dto: ConfirmPaymentDto) {
    // Ownership / existence (tenant-scoped, no lock).
    await this.findOne(tenantId, id);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Payment);
      const payment = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
      }

      // Idempotent: already settled → return as-is.
      if (payment.status === PaymentStatus.PAID) {
        return payment;
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
      }
      const gatewayPaymentId = payment.gateway_payment_id;
      if (!gatewayPaymentId) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'No gateway payment to verify for this payment',
        });
      }

      const provider = this.gateways.resolve(payment.gateway);
      const result = await provider.verifyPayment(gatewayPaymentId);

      await this.transactions.record(
        tenantId,
        payment.id,
        {
          type: TRANSACTION_TYPE.VERIFY,
          amount: Number(payment.amount),
          status: result.status,
          gatewayTransactionId: gatewayPaymentId,
          raw: result.raw,
        },
        manager,
      );

      if (result.status === 'paid') {
        payment.status = PaymentStatus.PAID;
        payment.paid_at = new Date();
      } else if (result.status === 'failed') {
        payment.status = PaymentStatus.FAILED;
      }
      return repo.save(payment);
    });
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
    return { data, total, page: query.page, limit: query.limit };
  }

  async findOne(tenantId: string, id: string): Promise<Payment> {
    const payment = await this.payments.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!payment) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Payment not found' });
    }
    return payment;
  }
}
