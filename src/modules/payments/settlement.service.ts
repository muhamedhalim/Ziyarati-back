import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  FindOptionsWhere,
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
import { SettlementAdjustmentService } from './settlement-adjustment.service';
import { GenerateSettlementDto } from './dto/generate-settlement.dto';
import { QuerySettlementsDto } from './dto/query-settlements.dto';
import {
  CLINIC_REVENUE_PURPOSES,
  DEFAULT_PAYMENT_CURRENCY,
  SETTLEMENT_MODE,
} from './payments.constants';

/**
 * Settlement batches (`settlements`).
 *
 * Aggregates the tenant's UNSETTLED, PAID payments (optionally by period/branch)
 * into a single batch, maps each payment via SettlementItemService, and flags
 * the payments IN_BATCH so they cannot be settled twice. Runs in one DB
 * transaction. Tenant-scoped via the `tenant` relation throughout.
 *
 * Eligible = the clinic's own money (`purpose` BOOKING/MANUAL) that ZiyaraTech
 * itself collected (`settlement_mode` INTERNAL). Platform revenue and
 * provider-settled payments are never batched.
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
    private readonly adjustments: SettlementAdjustmentService,
  ) {}

  async generate(tenantId: string, dto: GenerateSettlementDto) {
    // Resolve actual FK column names from metadata (naming-strategy-proof).
    const meta = this.payments.metadata;
    const tenantCol = meta.findRelationWithPropertyPath('tenant')!.joinColumns[0]
      .databaseName;
    const branchCol = meta.findRelationWithPropertyPath('branch')!.joinColumns[0]
      .databaseName;

    const settlementId = await this.dataSource.transaction(async (manager) => {
      // C2: atomically CLAIM eligible payments in a single UPDATE … RETURNING.
      // A concurrent generate() cannot claim the same rows — once flipped to
      // IN_BATCH they no longer satisfy the `settlement_status = UNSETTLED`
      // predicate, so no payment can land in two settlements (no double payout).
      // R1: settle on NET collectible value. Eligible = PAID or
      // PARTIALLY_REFUNDED + UNSETTLED; fully REFUNDED is excluded (status filter).
      // QueryBuilder .returning().execute() yields a deterministic `.raw` row set
      // (manager.query on UPDATE…RETURNING returns a [rows, count] tuple).
      const qb = manager
        .createQueryBuilder()
        .update(Payment)
        .set({ settlement_status: SettlementStatus.IN_BATCH })
        .where(`"${tenantCol}" = :tenantId`, { tenantId })
        .andWhere('status IN (:...statuses)', {
          statuses: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED],
        })
        .andWhere('settlement_status = :unsettled', {
          unsettled: SettlementStatus.UNSETTLED,
        })
        // ONLY money that is owed to the clinic AND that ZiyaraTech holds.
        // Without these two predicates the run claimed every PAID payment of
        // the tenant — including the clinic's own add-on / billing-upgrade
        // payments TO the platform (settled "back" to the clinic as payable),
        // and, under Tap Platform, charges Tap already settled straight to the
        // clinic's merchant account (a second payout of the same money). A
        // positive allow-list on purpose: a purpose added later is never
        // settled to a clinic until someone decides it should be.
        .andWhere('purpose IN (:...purposes)', {
          purposes: [...CLINIC_REVENUE_PURPOSES],
        })
        .andWhere('settlement_mode = :internalMode', {
          internalMode: SETTLEMENT_MODE.INTERNAL,
        });
      if (dto.branchId) {
        qb.andWhere(`"${branchCol}" = :branchId`, { branchId: dto.branchId });
      }
      if (dto.periodStart) {
        qb.andWhere('paid_at >= :periodStart', { periodStart: new Date(dto.periodStart) });
      }
      if (dto.periodEnd) {
        qb.andWhere('paid_at < :periodEnd', { periodEnd: new Date(dto.periodEnd) });
      }
      const claimedRes = await qb
        .returning(['id', 'amount', 'currency', 'gateway_fee', 'platform_fee'])
        .execute();
      const claimed = claimedRes.raw as Array<{
        id: string;
        amount: string;
        currency: string;
        gateway_fee: string | null;
        platform_fee: string | null;
      }>;

      // Claim OPEN clawbacks (refunds that landed after a prior settlement).
      const claw = await this.adjustments.lockOpen(manager, tenantId);

      if (claimed.length === 0 && claw.ids.length === 0) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'No unsettled payments or pending adjustments match the given criteria',
        });
      }

      // Exact integer-cent aggregation.
      const grossC = claimed.reduce(
        (c, p) => c + Math.round(Number(p.amount) * 100),
        0,
      );
      // Fees FROZEN on each payment at capture (gateway fee + platform
      // commission) — the clinic is owed NET of these, so the batch deducts
      // them. Zero on legacy/dev data (no fee data recorded ⇒ net = gross).
      const frozenFeesC = claimed.reduce(
        (c, p) =>
          c +
          Math.round(Number(p.gateway_fee ?? 0) * 100) +
          Math.round(Number(p.platform_fee ?? 0) * 100),
        0,
      );
      const refundedC = claimed.length
        ? await this.sumSucceededRefundsCents(manager, claimed.map((p) => p.id))
        : 0;
      // net collectible = collected − refunds-on-claimed − prior-settlement clawbacks.
      const netCollectibleC = grossC - refundedC - claw.totalCents;
      // Extra batch-level percent fee only on positive collectible; never on a
      // clawback-negative batch.
      const percentFeeC =
        netCollectibleC > 0
          ? Math.round((netCollectibleC * (dto.feePercent ?? 0)) / 100)
          : 0;
      const feeC = frozenFeesC + percentFeeC;
      const netC = netCollectibleC - feeC;
      const currency =
        dto.currency ?? claimed[0]?.currency ?? DEFAULT_PAYMENT_CURRENCY;

      const settlementRepo = manager.getRepository(Settlement);
      const settlement = await settlementRepo.save(
        settlementRepo.create({
          tenant: { id: tenantId } as Tenant,
          branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
          period_start: dto.periodStart ? new Date(dto.periodStart) : undefined,
          period_end: dto.periodEnd ? new Date(dto.periodEnd) : undefined,
          gross_amount: grossC / 100,
          fee_amount: feeC / 100,
          net_amount: netC / 100,
          currency,
          status: PayoutStatus.PENDING,
        }),
      );

      // Bind the claimed clawbacks to this settlement, and map the payments.
      // Claim + settlement commit together — a failure rolls everything back.
      await this.adjustments.markApplied(manager, claw.ids, settlement.id);
      if (claimed.length) {
        await this.itemsService.mapPayments(
          settlement.id,
          claimed.map((p) => p.id),
          manager,
        );
      }

      return settlement.id;
    });

    return this.getOne(tenantId, settlementId);
  }

  /** Exact SUM (SQL numeric) of SUCCEEDED refunds for the given payments, in cents. */
  private async sumSucceededRefundsCents(
    manager: import('typeorm').EntityManager,
    paymentIds: string[],
  ): Promise<number> {
    const row = await manager.query(
      `SELECT COALESCE(SUM(amount), 0) AS sum FROM refunds
       WHERE "paymentId" = ANY($1) AND status = 'SUCCEEDED'`,
      [paymentIds],
    );
    return Math.round(Number(row[0]?.sum ?? 0) * 100);
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
