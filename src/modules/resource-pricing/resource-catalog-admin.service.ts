import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
import { ResourcePriceChangeEvent } from '../../entities/ResourcePricing/ResourcePriceChangeEvent';
import { SubscriptionPlan } from '../../entities/SaaS-Core/SubscriptionPlan';
import { User } from '../../entities/Auth&RBAC/User';
import { AppError, ErrorCode } from '../../common/errors';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { PlanLimitStatusService } from '../subscription-billing/plan-limit-status.service';

import { findSellableResource } from './sellable-resource.registry';
import { assertSafeMinor } from './money';
import { UpdateResourcePriceDto } from './dto/update-resource-price.dto';
import { QueryResourcePriceHistoryDto } from './dto/query-resource-price-history.dto';

export interface ResourcePriceHistoryPage {
  data: ResourcePriceChangeEvent[];
  total: number;
  page: number;
  limit: number;
}

/** One admin-owned field change, queued for the audit trail alongside the save. */
interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * Super-admin catalog control (Phase 2.1, plan §19/§21).
 *
 * "CRUD" here is really "RU" — item rows are never created or deleted by an
 * admin; `ResourceCatalogBootstrap` owns row lifecycle (one row per
 * sellable-resource registry entry, Phase 1.1). This service only ever
 * updates the ADMIN-OWNED columns (`unit_price_minor`, `min_quantity`,
 * `max_quantity`, `currency`, `sort_order`, `is_active`) — `item_key`/
 * `kind`/`unit_label`/`unit_size` are code-owned and untouchable here.
 *
 * Every write appends to `resource_price_change_events` (append-only,
 * mirrors `PlatformAdminAuditService`'s before/after shape but scoped to
 * this one table).
 */
@Injectable()
export class ResourceCatalogAdminService {
  constructor(
    @InjectRepository(ResourcePriceCatalog)
    private readonly catalog: Repository<ResourcePriceCatalog>,
    @InjectRepository(ResourcePriceChangeEvent)
    private readonly events: Repository<ResourcePriceChangeEvent>,
    @InjectRepository(SubscriptionPlan)
    private readonly plans: Repository<SubscriptionPlan>,
    private readonly limitStatus: PlanLimitStatusService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Full catalogue including inactive/unpriced rows — the admin's own view.
   * `item_key` is a stable secondary key: every bootstrapped item shares
   * `sort_order: 0` until an admin customises it, and Postgres does not
   * guarantee a stable order for ties — without this, the Pricing tab's row
   * order could shuffle on every refetch (observed while verifying this
   * page: repeated edits from the same click landed on different rows as
   * the table silently re-sorted underneath the admin).
   */
  listAll(): Promise<ResourcePriceCatalog[]> {
    return this.catalog.find({ order: { sort_order: 'ASC', item_key: 'ASC' } });
  }

  /**
   * Paginated price-change audit trail (plan §19's "Price history" tab),
   * optionally scoped to one item. Every row is already a flat, display-ready
   * shape (`item_key`/`field`/`from_value`/`to_value`/`actor_email` are all
   * denormalised onto the event itself — see `ResourcePriceChangeEvent`), so
   * no join back to `resource_price_catalog` is needed to render a timeline.
   */
  async history(query: QueryResourcePriceHistoryDto): Promise<ResourcePriceHistoryPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [data, total] = await this.events.findAndCount({
      where: query.itemKey ? { item_key: query.itemKey } : {},
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  async getByKey(itemKey: string): Promise<ResourcePriceCatalog> {
    const item = await this.catalog.findOne({ where: { item_key: itemKey } });
    if (!item) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: `Catalog item "${itemKey}" not found`,
      });
    }
    return item;
  }

  /**
   * Coverage summary for the platform Pricing tab's badge — "Finite on 2 of
   * 5 active plans · 1 unlimited · 2 not configured" (plan §8/§19). Exposed
   * separately from `setActive` so the admin UI can show it BEFORE an
   * activation attempt, not only as a 422 reason after one.
   */
  async coverageFor(itemKey: string) {
    const spec = findSellableResource(itemKey);
    if (!spec) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: `"${itemKey}" has no sellable-resource registry entry`,
      });
    }
    const activePlans = await this.plans.find({ where: { is_active: true } });
    return this.limitStatus.coverage(activePlans, spec.planColumn as never);
  }

  async updatePrice(
    itemKey: string,
    dto: UpdateResourcePriceDto,
  ): Promise<ResourcePriceCatalog> {
    const item = await this.getByKey(itemKey);
    const changes: FieldChange[] = [];

    if (dto.unitPriceMinor !== undefined) {
      const maxQty = dto.maxQuantity ?? item.max_quantity;
      if (maxQty != null) {
        // §21 — the theoretical maximum purchase total must stay a safe integer.
        assertSafeMinor(
          BigInt(dto.unitPriceMinor) * BigInt(maxQty),
          `${itemKey}: max_quantity × unit_price_minor`,
        );
      }
      changes.push({
        field: 'unit_price_minor',
        from: item.unit_price_minor,
        to: String(dto.unitPriceMinor),
      });
      item.unit_price_minor = String(dto.unitPriceMinor);
    }
    if (dto.minQuantity !== undefined && dto.minQuantity !== item.min_quantity) {
      changes.push({
        field: 'min_quantity',
        from: String(item.min_quantity),
        to: String(dto.minQuantity),
      });
      item.min_quantity = dto.minQuantity;
    }
    if (dto.maxQuantity !== undefined && dto.maxQuantity !== item.max_quantity) {
      const unitPrice = dto.unitPriceMinor ?? Number(item.unit_price_minor);
      assertSafeMinor(
        BigInt(unitPrice) * BigInt(dto.maxQuantity),
        `${itemKey}: max_quantity × unit_price_minor`,
      );
      changes.push({
        field: 'max_quantity',
        from: item.max_quantity != null ? String(item.max_quantity) : null,
        to: String(dto.maxQuantity),
      });
      item.max_quantity = dto.maxQuantity;
    }
    if (dto.currency !== undefined && dto.currency !== item.currency) {
      changes.push({ field: 'currency', from: item.currency, to: dto.currency });
      item.currency = dto.currency;
    }
    if (dto.sortOrder !== undefined && dto.sortOrder !== item.sort_order) {
      changes.push({
        field: 'sort_order',
        from: String(item.sort_order),
        to: String(dto.sortOrder),
      });
      item.sort_order = dto.sortOrder;
    }

    if (changes.length === 0) return item;

    const actorId = this.actorId();
    item.updatedBy = actorId ? ({ id: actorId } as User) : undefined;
    const saved = await this.catalog.save(item);
    await this.recordChanges(saved, changes);
    return saved;
  }

  /**
   * Activating REFUSES (422) unless the item is priced, structurally
   * sellable, and covered by at least one active plan (plan §8's publish
   * gate). Deactivating is always allowed — availability is never frozen,
   * mirroring `PlanAdminService.setActive`'s own asymmetry.
   */
  async setActive(itemKey: string, isActive: boolean): Promise<ResourcePriceCatalog> {
    const item = await this.getByKey(itemKey);
    if (isActive) {
      await this.assertPublishable(item);
    }
    if (item.is_active === isActive) return item;

    const before = item.is_active;
    item.is_active = isActive;
    const actorId = this.actorId();
    item.updatedBy = actorId ? ({ id: actorId } as User) : undefined;
    const saved = await this.catalog.save(item);
    await this.recordChanges(saved, [
      { field: 'is_active', from: String(before), to: String(isActive) },
    ]);
    return saved;
  }

  private async assertPublishable(item: ResourcePriceCatalog): Promise<void> {
    const spec = findSellableResource(item.item_key);
    if (!spec) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `"${item.item_key}" has no sellable-resource registry entry and cannot be activated`,
      });
    }
    if (spec.eligibility === 'blocked') {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Cannot activate "${item.item_key}": ${spec.blockedReason}`,
      });
    }
    if (Number(item.unit_price_minor) <= 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Cannot activate "${item.item_key}": set a unit price greater than 0 first`,
      });
    }

    const activePlans = await this.plans.find({ where: { is_active: true } });
    const coverage = this.limitStatus.coverage(activePlans, spec.planColumn as never);
    if (coverage.finite === 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Cannot activate "${item.item_key}": no active plan has a Finite limit for ${spec.planColumn} — there is nothing to raise.`,
        publicContext: coverage,
      });
    }
  }

  private async recordChanges(
    item: ResourcePriceCatalog,
    changes: FieldChange[],
  ): Promise<void> {
    const actorId = this.actorId();
    const actorEmail = this.tenantContext.getUser()?.email ?? undefined;
    for (const change of changes) {
      const eventData: Partial<ResourcePriceChangeEvent> = {
        catalogItem: { id: item.id } as ResourcePriceCatalog,
        item_key: item.item_key,
        field: change.field,
        from_value: change.from ?? undefined,
        to_value: change.to ?? undefined,
        actor: actorId ? ({ id: actorId } as User) : undefined,
        actor_email: actorEmail,
      };
      await this.events.save(this.events.create(eventData));
    }
  }

  private actorId(): string | undefined {
    return this.tenantContext.getUser()?.id;
  }
}
