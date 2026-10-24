import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';

import { Transaction } from '../../entities/Payments/Transaction';
import { Payment } from '../../entities/Payments/Payment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { QueryTransactionsDto } from './dto/query-transactions.dto';

export interface RecordTransactionInput {
  type: string;
  amount: number;
  status: string;
  gatewayTransactionId?: string;
  raw?: Record<string, any>;
}

/**
 * Gateway interaction log (`transactions`).
 *
 * Every charge / verify / webhook / refund the domain performs is recorded here
 * with the raw provider response (`raw_response`) for debugging and audit.
 * Tenant-scoped via the `tenant` relation. `record()` accepts an optional
 * EntityManager so it can enlist in the caller's open DB transaction.
 */
@Injectable()
export class TransactionService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactions: Repository<Transaction>,
  ) {}

  record(
    tenantId: string,
    paymentId: string,
    input: RecordTransactionInput,
    manager?: EntityManager,
  ): Promise<Transaction> {
    const repo = manager
      ? manager.getRepository(Transaction)
      : this.transactions;
    const row = repo.create({
      tenant: { id: tenantId } as Tenant,
      payment: { id: paymentId } as Payment,
      type: input.type,
      amount: input.amount,
      status: input.status,
      gateway_transaction_id: input.gatewayTransactionId,
      raw_response: input.raw,
    });
    return repo.save(row);
  }

  async list(tenantId: string, query: QueryTransactionsDto) {
    const where: FindOptionsWhere<Transaction> = { tenant: { id: tenantId } };
    if (query.paymentId) where.payment = { id: query.paymentId };
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;

    const [rows, total] = await this.transactions.findAndCount({
      where,
      relations: { payment: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      data: rows.map((r) => this.forClient(r)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * FIN-X7 — the gateway's raw response and the full payment row stay internal
   * (support / reconciliation read them from the database). The clinic gets the
   * log entry and the payment's id and currency.
   */
  private forClient(row: Transaction): Transaction {
    const { raw_response: _raw, ...rest } = row;
    const p = row.payment;
    return {
      ...rest,
      payment: p ? ({ id: p.id, currency: p.currency } as Payment) : p,
    } as Transaction;
  }

  async findOneForClient(tenantId: string, id: string): Promise<Transaction> {
    return this.forClient(await this.findOne(tenantId, id));
  }

  async findOne(tenantId: string, id: string): Promise<Transaction> {
    const row = await this.transactions.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { payment: true },
    });
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Transaction not found' });
    }
    return row;
  }

  /**
   * Record a webhook transaction idempotently (H4). Relies on the partial UNIQUE
   * index on `transactions (gateway_transaction_id) WHERE type = 'webhook'`
   * (created by PaymentsSchemaBootstrap / migration). Returns `{ created: false }`
   * when this provider event was already recorded — a race-proof replacement for
   * the previous check-then-insert, which two concurrent redeliveries could both
   * pass. Non-webhook logs keep using `record()` and are unaffected by the index.
   */
  async recordWebhookOnce(
    tenantId: string,
    paymentId: string,
    input: RecordTransactionInput,
    manager?: EntityManager,
  ): Promise<{ created: boolean }> {
    const repo = manager
      ? manager.getRepository(Transaction)
      : this.transactions;
    try {
      await repo.insert({
        tenant: { id: tenantId } as Tenant,
        payment: { id: paymentId } as Payment,
        type: input.type,
        amount: input.amount,
        status: input.status,
        gateway_transaction_id: input.gatewayTransactionId,
        raw_response: input.raw,
      });
      return { created: true };
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        return { created: false }; // duplicate event — safe to ignore
      }
      throw err;
    }
  }
}
