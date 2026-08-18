import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';

import { ResourcePurchase } from '../../entities/ResourcePricing/ResourcePurchase';
import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { SubscriptionStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { ResourceCatalogService } from './resource-catalog.service';
import { PlanLimitStatusService, PlanLimitStatus } from '../subscription-billing/plan-limit-status.service';
import { PlanLimitColumn } from '../subscription-billing/plan-limit-status.service';
import { findSellableResource } from './sellable-resource.registry';
import { computeTotalMinor, computeDeltaUnits, toBigInt } from './money';
import { PaymentService } from '../payments/payment.service';
import { CreateResourcePurchaseDto } from './dto/create-resource-purchase.dto';
import { PreviewResourcePurchaseDto } from './dto/preview-resource-purchase.dto';
import { QueryResourcePurchasesDto } from './dto/query-resource-purchases.dto';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Live-count source table per CAPACITY item key (plan §19's add-on card
 * needs "current usage", which `GET /usage/breakdown` does not cover — that
 * endpoint's `getBreakdown()` is metered-metrics-only, by design). Mirrors
 * `platform-usage/usage-metrics.registry.ts`'s own per-metric `source.table`
 * values for the SAME six resources — a read-only display count, not a
 * quota/entitlement decision, so this does not duplicate enforcement logic
 * (each resource's own service — `branch.service.ts`, `staff.service.ts`,
 * `crm/customer.service.ts`, etc. — still owns the actual limit check).
 * `AI_TOKENS`/`WHATSAPP_MESSAGES`/`APPOINTMENTS`/`CAMPAIGNS` (credit items)
 * are intentionally absent — their usage already comes from
 * `GET /usage/breakdown`.
 */
const CAPACITY_USAGE_TABLE: Record<string, string> = {
  branches: 'branches',
  employees: 'users',
  customers: 'customers',
  uploadedFiles: 'file_uploads',
  knowledgeBaseFiles: 'ai_knowledge_bases',
  trainingFiles: 'ai_training_files',
};

export interface PurchasePreview {
  itemKey: string;
  kind: string;
  unitLabel: string;
  unitSize: number;
  unitPriceMinor: number;
  quantity: number;
  totalMinor: number;
  deltaUnits: number;
  currency: string;
  currentLimitStatus: PlanLimitStatus;
  currentLimit: number | null;
  resultingLimit: number | null;
}

export interface PurchaseResult {
  purchase: ResourcePurchase;
  redirectUrl?: string;
  paymentStatus?: string;
}

/**
 * Purchase preview/create/list/get (Phase 2.2, plan §16/§17/§20).
 *
 * `create()` takes NO price input — the total is always computed here, from
 * the catalog snapshot, never from the client. The inserted
 * `resource_purchases` row is then the SOLE input to everything downstream
 * (payment + Phase 2.3's entitlement listener); this service is the only
 * place that ever reads `resource_price_catalog` for a purchase.
 */
@Injectable()
export class ResourcePurchaseService {
  private readonly logger = new Logger('ResourcePurchaseService');

  constructor(
    @InjectRepository(ResourcePurchase)
    private readonly purchases: Repository<ResourcePurchase>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly dataSource: DataSource,
    private readonly catalogService: ResourceCatalogService,
    private readonly limitStatus: PlanLimitStatusService,
    private readonly paymentService: PaymentService,
  ) {}

  /**
   * The backend-authoritative price/limit preview (plan §19 — "the frontend
   * never multiplies a price"). Every number the owner add-on UI shows comes
   * from this response.
   */
  async preview(tenantId: string, dto: PreviewResourcePurchaseDto): Promise<PurchasePreview> {
    const item = await this.catalogService.getActiveByKey(dto.itemKey);
    const { planLimitRaw, status } = await this.resolveTenantLimit(tenantId, item);
    this.assertQuantityInRange(item, dto.quantity);
    this.assertFiniteLimit(item.item_key, status);

    const { totalMinor, deltaUnits } = this.computeSnapshot(item, dto.quantity);
    const currentLimit = planLimitRaw == null ? null : Number(planLimitRaw);

    return {
      itemKey: item.item_key,
      kind: item.kind,
      unitLabel: item.unit_label,
      unitSize: Number(item.unit_size),
      unitPriceMinor: Number(item.unit_price_minor),
      quantity: dto.quantity,
      totalMinor: Number(totalMinor),
      deltaUnits: Number(deltaUnits),
      currency: item.currency,
      currentLimitStatus: status,
      currentLimit,
      resultingLimit: currentLimit == null ? null : currentLimit + Number(deltaUnits),
    };
  }

  async create(
    tenantId: string,
    dto: CreateResourcePurchaseDto,
    actor: { id?: string; email?: string },
  ): Promise<PurchaseResult> {
    // Idempotent replay — a double-click with the SAME key returns the
    // existing purchase; no second row, no second charge.
    const existing = await this.findByKey(tenantId, dto.idempotencyKey);
    if (existing) return this.toResult(existing);

    const item = await this.catalogService.getActiveByKey(dto.itemKey);
    const { status } = await this.resolveTenantLimit(tenantId, item);
    this.assertQuantityInRange(item, dto.quantity);
    this.assertFiniteLimit(item.item_key, status);

    const { totalMinor, deltaUnits } = this.computeSnapshot(item, dto.quantity);

    let purchase: ResourcePurchase;
    try {
      purchase = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(ResourcePurchase);
        return repo.save(
          repo.create({
            tenant: { id: tenantId } as Tenant,
            purchasedBy: actor.id ? ({ id: actor.id } as User) : undefined,
            purchased_by_email: actor.email,
            catalogItem: { id: item.id } as ResourcePriceCatalog,
            item_key: item.item_key,
            kind: item.kind,
            unit_label: item.unit_label,
            unit_size: item.unit_size,
            quantity: dto.quantity,
            unit_price_minor: item.unit_price_minor,
            total_minor: totalMinor.toString(),
            delta_units: deltaUnits.toString(),
            currency: item.currency,
            status: 'payment_processing',
            idempotency_key: dto.idempotencyKey,
          }),
        );
      });
    } catch (err) {
      // Lost the (tenantId, idempotencyKey) unique race — another request
      // already created it; return the winner instead of a second row.
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        const winner = await this.findByKey(tenantId, dto.idempotencyKey);
        if (winner) return this.toResult(winner);
      }
      throw err;
    }

    // AFTER commit — the gateway call never happens inside a lock (mirrors
    // PaymentService.create's own two-phase discipline). `rp:${purchase.id}`
    // sidesteps `payments.idempotency_key`'s GLOBAL uniqueness entirely,
    // since purchase.id is a v4 UUID (plan §13).
    const totalMajor = Number(totalMinor) / 100;
    const { payment, redirectUrl } = await this.paymentService.create(
      tenantId,
      {
        amount: totalMajor,
        currency: item.currency,
        description: `${item.item_key} × ${dto.quantity}`,
        idempotencyKey: `rp:${purchase.id}`,
      },
      { platformRevenue: true },
    );

    // Race-safe link — only the first concurrent attempt wins, mirrors
    // BillingUpgradeService.accept()'s identical raw conditional UPDATE.
    await this.dataSource.query(
      `UPDATE "resource_purchases"
          SET "paymentId" = $1, payment_reference = $2, updated_at = now()
        WHERE id = $3 AND "paymentId" IS NULL`,
      [payment.id, payment.gateway_payment_id ?? null, purchase.id],
    );

    return { purchase, redirectUrl, paymentStatus: payment.status };
  }

  async list(tenantId: string, query: QueryResourcePurchasesDto) {
    const where: Record<string, unknown> = { tenant: { id: tenantId } };
    if (query.status) where.status = query.status;
    const [data, total] = await this.purchases.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Live count per sellable CAPACITY item, one batched query (no N+1) —
   * see {@link CAPACITY_USAGE_TABLE}. Storage is deliberately excluded: it
   * stays `eligibility: 'blocked'` in the sellable-resource registry, so
   * nothing purchases it and there is nothing for this to report.
   */
  async currentUsage(tenantId: string): Promise<Record<string, number>> {
    const entries = Object.entries(CAPACITY_USAGE_TABLE);
    const selects = entries.map(
      ([key, table]) => `(SELECT COUNT(*)::int FROM "${table}" WHERE "tenantId" = $1) AS "${key}"`,
    );
    const [row] = await this.dataSource.query(`SELECT ${selects.join(', ')}`, [tenantId]);
    const out: Record<string, number> = {};
    for (const [key] of entries) out[key] = Number(row?.[key] ?? 0);
    return out;
  }

  async get(tenantId: string, id: string): Promise<ResourcePurchase> {
    const purchase = await this.purchases.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!purchase) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Purchase not found' });
    }
    return purchase;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private findByKey(tenantId: string, key: string): Promise<ResourcePurchase | null> {
    return this.purchases.findOne({
      where: { tenant: { id: tenantId }, idempotency_key: key },
      relations: { payment: true },
    });
  }

  private toResult(purchase: ResourcePurchase): PurchaseResult {
    const payment = purchase.payment as unknown as
      | { status?: string; metadata?: Record<string, unknown> }
      | undefined;
    return {
      purchase,
      redirectUrl: payment?.metadata?.redirect_url as string | undefined,
      paymentStatus: payment?.status,
    };
  }

  private computeSnapshot(
    item: ResourcePriceCatalog,
    quantity: number,
  ): { totalMinor: bigint; deltaUnits: bigint } {
    const unitPriceMinor = toBigInt(item.unit_price_minor);
    const unitSize = toBigInt(item.unit_size);
    const qty = BigInt(quantity);
    return {
      totalMinor: computeTotalMinor(unitPriceMinor, qty),
      deltaUnits: computeDeltaUnits(unitSize, qty),
    };
  }

  private assertQuantityInRange(item: ResourcePriceCatalog, quantity: number): void {
    if (quantity < item.min_quantity) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Minimum purchase quantity for "${item.item_key}" is ${item.min_quantity}`,
      });
    }
    if (item.max_quantity != null && quantity > item.max_quantity) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Maximum purchase quantity for "${item.item_key}" is ${item.max_quantity}`,
      });
    }
  }

  private assertFiniteLimit(itemKey: string, status: PlanLimitStatus): void {
    if (status !== 'finite') {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          status === 'unlimited'
            ? `Your plan's limit for "${itemKey}" is already unlimited — there is nothing to raise.`
            : `Your plan's limit for "${itemKey}" is not configured — contact support before purchasing.`,
      });
    }
  }

  /**
   * The PURCHASING TENANT'S OWN current plan status for this item — distinct
   * from the catalog publish gate's "at least one active plan somewhere"
   * check (Phase 2.1). A tenant already on an unlimited (or unconfigured)
   * plan for this column has nothing to raise, even if the item is globally
   * purchasable for tenants on other plans.
   */
  private async resolveTenantLimit(
    tenantId: string,
    item: ResourcePriceCatalog,
  ): Promise<{ planColumn: PlanLimitColumn; planLimitRaw: unknown; status: PlanLimitStatus }> {
    const spec = findSellableResource(item.item_key);
    if (!spec) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `"${item.item_key}" has no sellable-resource registry entry`,
      });
    }
    const subscription = await this.subscriptions.findOne({
      where: {
        tenant: { id: tenantId },
        status: Not(SubscriptionStatus.CANCELLED),
        deleted_at: IsNull(),
      },
      relations: { plan: true },
      order: { created_at: 'DESC' },
    });
    if (!subscription) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'No active subscription to raise a limit on',
      });
    }
    const planColumn = spec.planColumn as PlanLimitColumn;
    const status = this.limitStatus.resolve(subscription.plan, planColumn);
    const planLimitRaw = (subscription.plan as unknown as Record<string, unknown>)[planColumn];
    return { planColumn, planLimitRaw, status };
  }
}
