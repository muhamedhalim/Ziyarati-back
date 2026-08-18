import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Read-only catalog access (Phase 2.1) — what an owner may browse and buy.
 * Deliberately scoped to `is_active` rows only: an inactive item (not yet
 * priced, or force-deactivated after a `unit_size` change) must never appear
 * in a purchase preview or be purchasable, even by a direct item-key request.
 * Admin CRUD lives in `ResourceCatalogAdminService`, which sees the full
 * catalog including inactive rows.
 */
@Injectable()
export class ResourceCatalogService {
  constructor(
    @InjectRepository(ResourcePriceCatalog)
    private readonly catalog: Repository<ResourcePriceCatalog>,
  ) {}

  /**
   * Every active, priced item — the owner add-on UI's full list.
   * `item_key` is a stable secondary key so ties on `sort_order` (every
   * bootstrapped item starts at 0) don't reshuffle across refetches — see
   * `ResourceCatalogAdminService.listAll`'s identical fix for why this
   * matters for a live, editable list.
   */
  listActive(): Promise<ResourcePriceCatalog[]> {
    return this.catalog.find({
      where: { is_active: true },
      order: { sort_order: 'ASC', item_key: 'ASC' },
    });
  }

  /** One active item by key, or 404 — the purchase-preview/create entry point. */
  async getActiveByKey(itemKey: string): Promise<ResourcePriceCatalog> {
    const item = await this.catalog.findOne({
      where: { item_key: itemKey, is_active: true },
    });
    if (!item) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: `"${itemKey}" is not available for purchase`,
      });
    }
    return item;
  }
}
