import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { FeatureCatalogService } from './feature-catalog.service';

/**
 * Reconciles `feature_definitions` / `feature_dependencies` with the code-owned
 * {@link FEATURE_REGISTRY} on every boot.
 *
 * The previous version seeded a hardcoded STARTER_CATALOG *only when the table
 * was empty*, which meant the catalog froze at whatever the first deployment
 * wrote. Capabilities added to the code afterwards never got a row, so a
 * super-admin had no toggle for them and `FeatureGuard` — which resolves a
 * feature by looking it up in that table — denied every request naming a key
 * with no definition. Syncing instead of seeding removes the drift entirely.
 *
 * Failures are logged, not thrown: the catalog is management metadata, and a
 * transient DB hiccup at boot must not stop the API from starting. The policy
 * itself fails closed independently, so a stale catalog cannot widen access.
 */
@Injectable()
export class FeatureCatalogBootstrap implements OnModuleInit {
  private readonly logger = new Logger(FeatureCatalogBootstrap.name);

  constructor(private readonly catalog: FeatureCatalogService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.catalog.syncRegistry();
    } catch (err) {
      this.logger.warn(
        `Feature registry sync skipped: ${(err as Error)?.message}`,
      );
    }
  }
}
