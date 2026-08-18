import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ResourcePriceCatalog } from '../../entities/ResourcePricing/ResourcePriceCatalog';
import { SELLABLE_RESOURCE_REGISTRY } from './sellable-resource.registry';

/**
 * Reconciles `resource_price_catalog` with the code-owned
 * {@link SELLABLE_RESOURCE_REGISTRY} on every boot — mirrors
 * `FeatureCatalogBootstrap`'s selective-upsert precedent exactly (sync, not
 * seed-once, so a registry item added later still gets a row).
 *
 * Column ownership, never violated in either direction:
 *   - `item_key`, `kind`, `unit_label`, `unit_size` — CODE-owned, refreshed
 *     from the registry on every boot.
 *   - `unit_price_minor`, `is_active`, `min_quantity`, `max_quantity`,
 *     `sort_order`, `currency` — ADMIN-owned, preserved across restarts.
 *     A NEW row gets safe defaults (`unit_price_minor: 0`, `is_active:
 *     false`) — never active, never priced, until an admin explicitly sets
 *     both (`ResourceCatalogAdminService`'s publish gate).
 *
 * One safety rule beyond the `FeatureCatalogBootstrap` precedent: if
 * `unit_size` changes for an EXISTING row, the item is force-deactivated —
 * the price now means something different (e.g. "per 1,000 tokens" becoming
 * "per 1 token") and must be re-confirmed by an admin before it can sell
 * again.
 *
 * Failures are logged, never thrown — the catalog is management metadata; a
 * transient DB hiccup at boot must not stop the API from starting.
 */
@Injectable()
export class ResourceCatalogBootstrap implements OnModuleInit {
  private readonly logger = new Logger(ResourceCatalogBootstrap.name);

  constructor(
    @InjectRepository(ResourcePriceCatalog)
    private readonly catalog: Repository<ResourcePriceCatalog>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const result = await this.syncCatalog();
      this.logger.log(
        `Resource price catalog synced: ${result.created} created, ${result.refreshed} refreshed, ` +
          `${result.deactivated} deactivated (unit_size change), ${SELLABLE_RESOURCE_REGISTRY.length} total`,
      );
    } catch (err) {
      this.logger.warn(
        `Resource price catalog sync skipped: ${(err as Error)?.message}`,
      );
    }
  }

  async syncCatalog(): Promise<{
    created: number;
    refreshed: number;
    deactivated: number;
  }> {
    let created = 0;
    let refreshed = 0;
    let deactivated = 0;

    for (const spec of SELLABLE_RESOURCE_REGISTRY) {
      const existing = await this.catalog.findOne({
        where: { item_key: spec.itemKey },
      });

      if (!existing) {
        await this.catalog.save(
          this.catalog.create({
            item_key: spec.itemKey,
            kind: spec.kind,
            unit_label: spec.unitLabel,
            unit_size: String(spec.unitSize),
            unit_price_minor: '0',
            currency: 'SAR',
            min_quantity: 1,
            is_active: false,
            sort_order: 0,
          }),
        );
        created++;
        continue;
      }

      const previousUnitSize = existing.unit_size;
      const unitSizeChanged = previousUnitSize !== String(spec.unitSize);
      const codeFieldsChanged =
        existing.kind !== spec.kind ||
        existing.unit_label !== spec.unitLabel ||
        unitSizeChanged;

      if (!codeFieldsChanged) continue;

      existing.kind = spec.kind;
      existing.unit_label = spec.unitLabel;
      existing.unit_size = String(spec.unitSize);
      if (unitSizeChanged && existing.is_active) {
        existing.is_active = false;
        deactivated++;
        this.logger.warn(
          `Catalog item "${spec.itemKey}" unit_size changed (${previousUnitSize} → ${spec.unitSize}) — ` +
            'deactivated. Re-confirm the price before reactivating.',
        );
      }
      await this.catalog.save(existing);
      refreshed++;
    }

    return { created, refreshed, deactivated };
  }
}
