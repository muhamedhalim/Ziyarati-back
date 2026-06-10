import { Injectable } from '@nestjs/common';
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

import { Settlement } from '../../entities/Payments/Settlement';
import { Payment } from '../../entities/Payments/Payment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { PaymentStatus, PayoutStatus, SettlementStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { SettlementItemService } from './settlement-item.service';
import { GenerateSettlementDto } from './dto/generate-settlement.dto';
import { QuerySettlementsDto } from './dto/query-settlements.dto';
import { DEFAULT_PAYMENT_CURRENCY, round2 } from './payments.constants';

/**
 * Settlement batches (`settlements`).
 *
 * Aggregates the tenant's UNSETTLED, PAID payments (optionally by period/branch)
 * into a single batch, maps each payment via SettlementItemService, and flags
 * the payments IN_BATCH so they cannot be settled twice. Runs in one DB
 * transaction. Tenant-scoped via the `tenant` relation throughout.
 */
@Injectable()
export class SettlementService {
  constructor(
    @InjectRepository(Settlement)
    private readonly settlements: Repository<Settlement>,
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly itemsService: SettlementItemService,
  ) {}

  async generate(tenantId: string, dto: GenerateSettlementDto) {
    const settlementId = await this.dataSource.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);

      const where: FindOptionsWhere<Payment> = {
        tenant: { id: tenantId },
        status: PaymentStatus.PAID,
        settlement_status: SettlementStatus.UNSETTLED,
      };
      if (dto.branchId) where.branch = { id: dto.branchId };
      if (dto.periodStart && dto.periodEnd) {
        where.paid_at = Between(new Date(dto.periodStart), new Date(dto.periodEnd));
      } else if (dto.periodStart) {
        where.paid_at = MoreThanOrEqual(new Date(dto.periodStart));
      } else if (dto.periodEnd) {
        where.paid_at = LessThan(new Date(dto.periodEnd));
      }

      const eligible = await paymentRepo.find({ where });
      if (eligible.length === 0) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'No unsettled, paid payments match the given criteria',
        });
      }

      const currency =
        dto.currency ?? eligible[0].currency ?? DEFAULT_PAYMENT_CURRENCY;
      const gross = round2(eligible.reduce((sum, p) => sum + Number(p.amount), 0));
      const feePercent = dto.feePercent ?? 0;
      const fee = round2((gross * feePercent) / 100);
      const net = round2(gross - fee);

      const settlementRepo = manager.getRepository(Settlement);
      const settlement = await settlementRepo.save(
        settlementRepo.create({
          tenant: { id: tenantId } as Tenant,
          branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
          period_start: dto.periodStart ? new Date(dto.periodStart) : undefined,
          period_end: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
          gross_amount: gross,
          fee_amount: fee,
          net_amount: net,
          currency,
          status: PayoutStatus.PENDING,
        }),
      );

      await this.itemsService.mapPayments(
        settlement.id,
        eligible.map((p) => p.id),
        manager,
      );

      // Flag the payments as batched so a second run can't re-settle them.
      await paymentRepo.update(
        { id: In(eligible.map((p) => p.id)) },
        { settlement_status: SettlementStatus.IN_BATCH },
      );

      return settlement.id;
    });

    return this.getOne(tenantId, settlementId);
  }

  async list(tenantId: string, query: QuerySettlementsDto) {
    const where: FindOptionsWhere<Settlement> = { tenant: { id: tenantId } };
    if (query.status) where.status = query.status;
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    const [data, total] = await this.settlements.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /** Settlement with its composed payment items (entity has no inverse relation). */
  async getOne(tenantId: string, id: string) {
    const settlement = await this.findOne(tenantId, id);
    const items = await this.itemsService.listForSettlement(id);
    return { ...settlement, items };
  }

  async findOne(tenantId: string, id: string): Promise<Settlement> {
    const settlement = await this.settlements.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!settlement) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Settlement not found' });
    }
    return settlement;
  }
}
