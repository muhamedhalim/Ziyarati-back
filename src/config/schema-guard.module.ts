import { Global, Module } from '@nestjs/common';

import { SchemaGuardRegistry } from './schema-guard.registry';
import { SchemaGuardCatalogService } from './schema-guard-catalog.service';

/**
 * Global (same rationale as `MetricsModule`) so every module's schema
 * bootstrap can record its outcomes without each one importing this
 * explicitly — and, more importantly, so BOTH process roots (`AppModule` and
 * `WorkerModule`) share the identical policy. A worker that quietly installed
 * a guard the API refused to, or vice versa, would reintroduce exactly the
 * "survival depends on which module happens to run" accident P0.2 documented.
 *
 * `SchemaGuardCatalogService` (P0.5) lives here rather than in a domain
 * module for the same reason: it is cross-cutting (all 43 curated guards,
 * not one module's own objects), so registering it once, globally, is what
 * guarantees it runs in both process roots without either one having to
 * remember to import it.
 *
 * Registers no controller: the readiness surface belongs to `HealthModule`,
 * which the worker (a pure application context with no HTTP adapter) does not
 * mount.
 */
@Global()
@Module({
  providers: [SchemaGuardRegistry, SchemaGuardCatalogService],
  exports: [SchemaGuardRegistry],
})
export class SchemaGuardModule {}
