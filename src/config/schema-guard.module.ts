import { Global, Module } from '@nestjs/common';

import { SchemaGuardRegistry } from './schema-guard.registry';

/**
 * Global (same rationale as `MetricsModule`) so every module's schema
 * bootstrap can record its outcomes without each one importing this
 * explicitly — and, more importantly, so BOTH process roots (`AppModule` and
 * `WorkerModule`) share the identical policy. A worker that quietly installed
 * a guard the API refused to, or vice versa, would reintroduce exactly the
 * "survival depends on which module happens to run" accident P0.2 documented.
 *
 * Registers no controller: the readiness surface belongs to `HealthModule`,
 * which the worker (a pure application context with no HTTP adapter) does not
 * mount.
 */
@Global()
@Module({
  providers: [SchemaGuardRegistry],
  exports: [SchemaGuardRegistry],
})
export class SchemaGuardModule {}
