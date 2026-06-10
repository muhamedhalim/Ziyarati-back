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

    const [data, total] = await this.transactions.findAndCount({
      where,
      relations: { payment: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
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

  /** Webhook idempotency: has this provider event already been recorded? */
  async existsByGatewayEvent(eventId: string, type: string): Promise<boolean> {
    const count = await this.transactions.count({
      where: { gateway_transaction_id: eventId, type },
    });
    return count > 0;
  }
}
