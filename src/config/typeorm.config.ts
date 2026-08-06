import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'node:path';

import { runMigrationsWithAdvisoryLock } from './run-migrations-with-lock';

/**
 * Shared TypeORM configuration factory.
 *
 * Extracted from AppModule so BOTH process roots — the HTTP API (`main.ts`) and
 * the BullMQ worker (`worker.ts`) — use byte-identical database wiring. Behavior
 * is unchanged from the original inline factory; only the entities glob is made
 * relative to this file's new location (`config/` → `../entities`).
 *
 * `poolRole` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.6)
 * lets the API and worker size their pools independently via
 * `API_DB_POOL_MAX`/`WORKER_DB_POOL_MAX` instead of sharing one `DB_POOL_MAX`
 * name (easy to accidentally apply the same value to both from one shared env
 * template). Each falls back to `DB_POOL_MAX` (default 15) when its
 * role-specific var is unset, so an existing deployment that only sets
 * `DB_POOL_MAX` is completely unaffected.
 */
export async function typeOrmFactory(
  config: ConfigService,
  poolRole: 'api' | 'worker' = 'api',
): Promise<TypeOrmModuleOptions> {
  const logger = new Logger('TypeORM');

  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const databaseUrl = config.get<string>('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error('❌ DATABASE_URL is missing in .env');
  }

  const enableSync = config.get<string>('TYPEORM_SYNCHRONIZE') === 'true';
  const logging = config.get<string>('TYPEORM_LOGGING') === 'true';
  const synchronize = !isProduction && enableSync;

  if (isProduction && enableSync) {
    throw new Error('❌ TypeORM synchronize is NOT allowed in production');
  }
  if (synchronize) {
    logger.warn('⚠️ TypeORM synchronize ENABLED (DEV ONLY)');
  }

  // Run migrations here — inside `useFactory`, before Nest's own
  // `TypeOrmCoreModule` initializes the runtime `DataSource` and before ANY
  // module's `onModuleInit()` fires — rather than relying on TypeORM's own
  // `migrationsRun` option. `migrationsRun` runs once per process root with
  // no cross-process coordination, so `AppModule` and `WorkerModule` booting
  // together (or N replicas of either) could race the same migration
  // (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M11). Wrapping it in a
  // Postgres advisory lock here serializes every booting process without
  // changing WHEN migrations complete relative to the rest of app startup.
  if (!synchronize) {
    await runMigrationsWithAdvisoryLock(databaseUrl, isProduction);
  }

  return {
    type: 'postgres',
    url: databaseUrl,
    autoLoadEntities: true,
    // The `!(*.spec)` exclusion only matters when this factory resolves
    // against the TS source tree (ts-jest e2e tests) rather than the compiled
    // `dist/` output: `tsconfig.build.json` already excludes `*.spec.ts` from
    // the build, so `dist/entities/**` / `dist/migrations/**` never contain
    // one. Against source it would otherwise `require()` a `*.spec.ts` file as
    // if it were an entity/migration class — which also registers its
    // `it()`/`describe()` calls against whatever Jest test happened to
    // trigger DataSource.initialize(), and crashes with "Cannot add a test
    // after tests have started running." Applies to BOTH globs — migrations
    // has the exact same spec-file collision as entities (e.g.
    // `1730003800000-AiFinopsHardening.spec.ts` sits next to its migration).
    // MUST be a single glob (not a second `!pattern` array entry) — TypeORM's
    // DirectoryExportedClassesLoader globs each array element SEPARATELY and
    // concatenates the results, so a lone negation entry has no positive
    // match to exclude from and is silently a no-op.
    entities: [join(__dirname, '..', 'entities', '**', '!(*.spec).{ts,js}')],
    migrations: [join(__dirname, '..', 'migrations', '!(*.spec).{ts,js}')],
    synchronize,
    // Migrations already ran above (or were skipped because `synchronize` is
    // on) — NOT delegated to TypeORM's own `migrationsRun`, which has no
    // cross-process coordination (see the advisory-lock call above, M11).
    migrationsRun: false,
    // Each migration commits independently (gap-closure pass — see
    // docs/CACHING_QUEUES_AUDIT.md §0.8.3): TypeORM's default groups every
    // pending migration from one boot into a single transaction, which would
    // let a FUTURE migration that both adds and uses a new enum value in the
    // same deploy hit Postgres's "unsafe use of new value" error if it landed
    // in the same transaction as the migration that added it (see
    // OutboxHardening's `ALTER TYPE ... ADD VALUE`). 'each' closes that
    // structurally rather than by convention.
    migrationsTransactionMode: 'each',
    logging: logging ? ['query', 'error', 'warn'] : ['error'],
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    extra: {
      // Default raised 10 → 15 (Phase 0 correction, measured — see
      // docs/CACHING_QUEUES_AUDIT.md §0.3). NOT raised to match the worker's
      // theoretical concurrency sum: the local benchmark showed acquisition
      // wait scales with the oversubscription RATIO (concurrency/poolMax), not
      // the raw concurrency number, and pool size beyond ~1.5-2x oversubscription
      // has diminishing returns for this workload. Pair this with `WORKER_ROLE`
      // (queue.constants.ts) to actually reduce the ratio for the campaign
      // dispatch hot path, rather than growing this number indefinitely — each
      // deployment (API, critical worker, dispatch worker) can still override
      // via its own DB_POOL_MAX env var, or the role-specific
      // API_DB_POOL_MAX/WORKER_DB_POOL_MAX (§0.8.6).
      max: poolMax(config, poolRole),
      min: config.get<number>('DB_POOL_MIN', 1) ?? 1,
      idleTimeoutMillis: config.get<number>('DB_POOL_IDLE_TIMEOUT', 30000),
      // FND-047 — defense-in-depth, NOT the primary fix (the primary fix is
      // UsageService.incrementIfWithinLimit's manager-threading, which removes
      // the nested-connection acquisition that caused pool exhaustion to
      // deadlock instead of merely queueing). node-postgres's own default is 0
      // (wait forever), so ANY future path that oversubscribes the pool would
      // otherwise hang indefinitely with no clear error, exactly like FND-047
      // did. A bounded wait turns that into a clear, fail-fast `ETIMEDOUT`-style
      // rejection instead of a silent, permanent hang.
      connectionTimeoutMillis: config.get<number>('DB_POOL_CONNECTION_TIMEOUT', 10000),
    },
  } as TypeOrmModuleOptions;
}

/** Role-specific pool size, falling back to the shared `DB_POOL_MAX` (default 15) when unset. */
function poolMax(config: ConfigService, poolRole: 'api' | 'worker'): number {
  const specific = config.get<number>(
    poolRole === 'worker' ? 'WORKER_DB_POOL_MAX' : 'API_DB_POOL_MAX',
  );
  return specific !== undefined && specific !== null
    ? specific
    : (config.get<number>('DB_POOL_MAX', 15) ?? 15);
}
