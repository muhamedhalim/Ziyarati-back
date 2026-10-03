import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Repository, EntityManager } from 'typeorm';

import { BillingUpgradeRequest } from '../../entities/BillingUpgrades/BillingUpgradeRequest';
import { User } from '../../entities/Auth&RBAC/User';
import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
import { AppError, ErrorCode } from '../../common/errors';

import { UsageService } from '../subscription-billing/usage.service';
import { UsageMetric } from '../subscription-billing/usage-metric';
import { computeTotalMinor, toBigInt } from '../resource-pricing/money';

import { BillingUpgradeEventService } from './billing-upgrade-event.service';
import { lockRequest } from './billing-upgrade-lock.util';
import { BillingUpgradeAiEstimateService } from './billing-upgrade-ai-estimate.service';
import { QuoteBillingUpgradeRequestDto } from './dto/quote-billing-upgrade-request.dto';
import { RejectBillingUpgradeRequestDto } from './dto/reject-billing-upgrade-request.dto';
import { QueryPlatformBillingUpgradeRequestsDto } from './dto/query-billing-upgrade-requests.dto';
import {
  BILLING_UPGRADE_EVENT_TYPE,
  BILLING_UPGRADE_STATUS,
  BILLING_UPGRADE_TYPE,
  BillingUpgradeStatus,
  BillingUpgradeType,
  QUOTABLE_BILLING_UPGRADE_STATUSES,
  REJECTABLE_BILLING_UPGRADE_STATUSES,
  TERMINAL_BILLING_UPGRADE_STATUSES,
} from './billing-upgrade.constants';

export interface BillingUpgradeActor {
  id: string;
  email?: string;
}

/**
 * Platform (super-admin) side of the billing-upgrade workflow: cross-tenant
 * listing, the advisory AI estimate, quoting, and rejection. Guarded at the
 * controller by `@Roles(ROLE.SUPER_ADMIN)` — matches PlatformBillingAdminController.
 *
 * `quote()` is the ONLY place `final_price_minor`/`approved_quantity` are set —
 * the owner's accept endpoint never accepts these from the client.
 */
@Injectable()
export class BillingUpgradeAdminService {
  constructor(
    @InjectRepository(BillingUpgradeRequest)
    private readonly requests: Repository<BillingUpgradeRequest>,
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly aiEstimate: BillingUpgradeAiEstimateService,
    private readonly history: BillingUpgradeEventService,
  ) {}

  /**
   * If `usage_metric` has an active, priced Pricing Catalog entry (plan §21 —
   * `resource_price_catalog`, the SAME table the self-serve `resource-pricing`
   * module sells from) AND the request has a finite `current_limit`, the quote
   * price is derived ENTIRELY server-side from `unit_price_minor × lots` —
   * `dto.finalPriceMinor` is never trusted for this path, only ever recomputed
   * (requirement: "do not rely solely on the frontend price"). Returns `null`
   * when no catalog price applies, so the caller falls back to the pre-existing
   * fully-manual admin price — unpriced/inactive items and `type: 'feature'`
   * requests are unaffected by this change.
   *
   * `approvedQuantity` remains a NEW ABSOLUTE LIMIT (unchanged contract); the
   * billable quantity is the DELTA above `current_limit`, which must land
   * exactly on a catalog `unit_size` multiple — the frontend slider always
   * produces one, but this also closes the gap for any direct API caller.
   */
  private async computeCatalogPriceMinor(
    manager: EntityManager,
    usageMetric: string,
    currentLimitRaw: string | undefined,
    approvedQuantity: number,
  ): Promise<number | null> {
    const catalogItem = await manager
      .getRepository(ResourcePriceCatalog)
      .findOne({ where: { item_key: usageMetric } });
    if (!catalogItem || !catalogItem.is_active || Number(catalogItem.unit_price_minor) <= 0) {
      return null;
    }
    if (currentLimitRaw === undefined || currentLimitRaw === null) {
      // No finite current limit to measure a delta against — fall back to manual pricing.
      return null;
    }

    const currentLimit = Number(currentLimitRaw);
    const unitSize = Number(catalogItem.unit_size);
    const delta = approvedQuantity - currentLimit;

    if (delta <= 0 || delta % unitSize !== 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `approvedQuantity must exceed the current limit by a whole multiple of ${unitSize} (the catalog unit size for "${usageMetric}")`,
        publicContext: { currentLimit, unitSize },
      });
    }

    const quantityLots = delta / unitSize;
    const maxQuantity = catalogItem.max_quantity;
    if (quantityLots < catalogItem.min_quantity || (maxQuantity != null && quantityLots > maxQuantity)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Quantity is outside the catalog's allowed range (${catalogItem.min_quantity}–${maxQuantity ?? '∞'} × ${unitSize} for "${usageMetric}")`,
        publicContext: { minQuantity: catalogItem.min_quantity, maxQuantity, unitSize },
      });
    }

    const totalMinor = computeTotalMinor(toBigInt(catalogItem.unit_price_minor), BigInt(quantityLots));
    return Number(totalMinor);
  }

  async list(query: QueryPlatformBillingUpgradeRequestsDto) {
    const where: FindOptionsWhere<BillingUpgradeRequest> = {};
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.tenantId) where.tenant = { id: query.tenantId };

    const [data, total] = await this.requests.findAndCount({
      where,
      relations: { tenant: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    const planNames = await this.planNamesByTenant(data.map((r) => r.tenant.id));
    const enriched = data.map((r) => ({ ...r, planName: planNames.get(r.tenant.id) ?? null }));
    return { data: enriched, total, page: query.page, limit: query.limit };
  }

  async get(id: string) {
    const request = await this.findOne(id);
    const events = await this.history.listAll(id);
    return { ...request, events };
  }

  /** Generate (or refresh) the advisory AI cost estimate. Never blocks manual pricing on failure. */
  async generateEstimate(id: string, actor: BillingUpgradeActor): Promise<BillingUpgradeRequest> {
    const request = await this.findOne(id);
    if (TERMINAL_BILLING_UPGRADE_STATUSES.includes(request.status as BillingUpgradeStatus)) {
      throw new AppError(ErrorCode.INVALID_REQUEST_STATUS, {
        message: `Cannot generate an estimate for a request in status "${request.status}"`,
      });
    }

    let historicalAverageUsage: number | null = null;
    if (request.type === BILLING_UPGRADE_TYPE.USAGE_LIMIT && request.usage_metric) {
      historicalAverageUsage = await this.usage.getHistoricalAverage(
        request.tenant.id,
        request.usage_metric as UsageMetric,
      );
    }

    const result = await this.aiEstimate.estimate({
      // Attribution for the AI cost ledger. The spend belongs to the tenant the
      // quote is being prepared for; `ai_cost_entries.tenant_id` is a real FK to
      // `tenants(id)`, so there is no synthetic "platform" tenant to book it to.
      tenantId: request.tenant.id,
      requestId: id,
      requestType: request.type as BillingUpgradeType,
      targetKey:
        request.type === BILLING_UPGRADE_TYPE.FEATURE ? request.feature_key! : request.usage_metric!,
      requestedQuantity: request.requested_quantity !== undefined ? Number(request.requested_quantity) : null,
      currentUsage: request.current_usage !== undefined ? Number(request.current_usage) : null,
      currentLimit: request.current_limit !== undefined ? Number(request.current_limit) : null,
      billingPeriod: request.billing_period ?? null,
      historicalAverageUsage,
      currency: request.currency,
    });

    request.ai_estimated_provider_cost_minor = String(result.estimatedProviderCostMinor);
    request.ai_estimated_infra_cost_minor = String(result.estimatedInfraCostMinor);
    request.ai_recommended_price_minor = String(result.recommendedPriceMinor);
    request.ai_confidence_score = result.confidenceScore.toFixed(4);
    request.ai_assumptions = result.assumptions;
    request.ai_pricing_breakdown = result.pricingBreakdown;
    request.ai_estimate_error = result.error;
    request.ai_estimate_generated_at = new Date();
    const saved = await this.requests.save(request);

    await this.history.record({
      requestId: id,
      type: BILLING_UPGRADE_EVENT_TYPE.AI_ESTIMATE_GENERATED,
      note: result.error,
      metadata: { ...result },
      internalOnly: true,
      actorId: actor.id,
      actorName: actor.email,
    });

    return saved;
  }

  async quote(
    id: string,
    actor: BillingUpgradeActor,
    dto: QuoteBillingUpgradeRequestDto,
  ): Promise<BillingUpgradeRequest> {
    const expiresAt = new Date(dto.quoteExpiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'quoteExpiresAt must be a valid future date',
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BillingUpgradeRequest);
      // Lock first, join after: FOR UPDATE + a LEFT JOINed relation is refused by Postgres.
      const request = await lockRequest(manager, { id }, { tenant: true });
      if (!request) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Request not found' });
      }
      if (!QUOTABLE_BILLING_UPGRADE_STATUSES.includes(request.status as BillingUpgradeStatus)) {
        throw new AppError(ErrorCode.INVALID_REQUEST_STATUS, {
          message: `Request cannot be quoted from status "${request.status}"`,
        });
      }

      let finalPriceMinor = dto.finalPriceMinor;

      if (request.type === BILLING_UPGRADE_TYPE.USAGE_LIMIT) {
        if (dto.approvedQuantity == null) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, {
            message: 'approvedQuantity is required for usage_limit requests',
          });
        }
        const currentLimit = request.current_limit !== undefined ? Number(request.current_limit) : null;
        if (currentLimit !== null && dto.approvedQuantity <= currentLimit) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: 'approvedQuantity must exceed the current plan limit',
            publicContext: { currentLimit, approvedQuantity: dto.approvedQuantity },
          });
        }
        request.approved_quantity = String(dto.approvedQuantity);

        if (request.usage_metric) {
          const catalogPriceMinor = await this.computeCatalogPriceMinor(
            manager,
            request.usage_metric,
            request.current_limit,
            dto.approvedQuantity,
          );
          if (catalogPriceMinor !== null) {
            finalPriceMinor = catalogPriceMinor;
          }
        }
      }

      const fromStatus = request.status;
      request.final_price_minor = String(finalPriceMinor);
      request.billing_period = dto.billingPeriod;
      request.quote_expires_at = expiresAt;
      request.reviewer = { id: actor.id } as User;
      request.reviewer_notes = dto.notes;
      request.status = BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL;
      const saved = await repo.save(request);

      await this.history.record(
        {
          requestId: id,
          type: BILLING_UPGRADE_EVENT_TYPE.QUOTED,
          fromValue: fromStatus,
          toValue: BILLING_UPGRADE_STATUS.AWAITING_OWNER_APPROVAL,
          note: dto.notes,
          metadata: {
            approvedQuantity: dto.approvedQuantity ?? null,
            finalPriceMinor,
            billingPeriod: dto.billingPeriod,
            quoteExpiresAt: dto.quoteExpiresAt,
          },
          actorId: actor.id,
          actorName: actor.email,
        },
        manager,
      );
      return saved;
    });
  }

  async reject(
    id: string,
    actor: BillingUpgradeActor,
    dto: RejectBillingUpgradeRequestDto,
  ): Promise<BillingUpgradeRequest> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BillingUpgradeRequest);
      const request = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!request) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Request not found' });
      }
      if (!REJECTABLE_BILLING_UPGRADE_STATUSES.includes(request.status as BillingUpgradeStatus)) {
        throw new AppError(ErrorCode.INVALID_REQUEST_STATUS, {
          message: `Request cannot be rejected from status "${request.status}"`,
        });
      }
      const fromStatus = request.status;
      request.status = BILLING_UPGRADE_STATUS.REJECTED;
      request.rejected_at = new Date();
      request.rejection_reason = dto.reason;
      const saved = await repo.save(request);

      await this.history.record(
        {
          requestId: id,
          type: BILLING_UPGRADE_EVENT_TYPE.STATUS_CHANGED,
          fromValue: fromStatus,
          toValue: BILLING_UPGRADE_STATUS.REJECTED,
          note: dto.reason,
          actorId: actor.id,
          actorName: actor.email,
        },
        manager,
      );
      return saved;
    });
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async findOne(id: string): Promise<BillingUpgradeRequest> {
    const request = await this.requests.findOne({ where: { id }, relations: { tenant: true } });
    if (!request) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Request not found' });
    }
    return request;
  }

  /** One query for every distinct tenant's current plan name — avoids N+1 on the list view. */
  private async planNamesByTenant(tenantIds: string[]): Promise<Map<string, string>> {
    const distinct = [...new Set(tenantIds)];
    if (distinct.length === 0) return new Map();
    const rows: Array<{ tenant_id: string; plan_name: string }> = await this.dataSource.query(
      `SELECT DISTINCT ON (s."tenantId") s."tenantId" AS tenant_id, p.name AS plan_name
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s."planId"
       WHERE s."tenantId" = ANY($1) AND s.deleted_at IS NULL
       ORDER BY s."tenantId", s.created_at DESC`,
      [distinct],
    );
    return new Map(rows.map((r) => [r.tenant_id, r.plan_name]));
  }
}
