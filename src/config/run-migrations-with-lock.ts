import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { join } from 'node:path';
import type { TlsOptions } from 'node:tls';

import { SafeTypeOrmLogger } from '../common/logging/typeorm-safe-logger';

/**
 * Fixed Postgres advisory-lock id serializing migration runs across every
 * process root (API + worker) and every replica of each (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M11). `migrationsRun: !synchronize` used to be
 * set independently on both `AppModule` and `WorkerModule`'s `typeOrmFactory`
 * call, so a deploy that starts both roots together could race the same
 * migration. Arbitrary constant, just needs to be stable and unique to this
 * app's migration lock (not shared with any other advisory-lock use in this
 * codebase — none exist today).
 */
const MIGRATION_LOCK_ID = 8_237_501_001;

/**
 * Runs pending migrations serialized behind `pg_advisory_lock`, using a
 * SEPARATE, short-lived `DataSource` dedicated to the migration step (same
 * pattern TypeORM's own CLI uses — see `data-source.ts`) rather than the
 * Nest-managed runtime `DataSource`. This is called from inside
 * `typeOrmFactory`'s `useFactory` — i.e. BEFORE Nest's `TypeOrmCoreModule`
 * initializes the real `DataSource` and before ANY other module's
 * `onModuleInit()` runs (some, e.g. `FeatureCatalogBootstrap`, write rows on
 * boot and need the migrated schema to already exist) — so this preserves
 * the exact "migrations complete before the app does anything else"
 * ordering `migrationsRun: true` used to give, while adding the missing
 * cross-process serialization.
 *
 * `pg_advisory_lock` is session-scoped: acquire and release MUST happen on
 * the same physical connection, so a dedicated `QueryRunner` (not the
 * pooled `DataSource.query()`, which can hand different calls different
 * connections) holds it for the whole critical section. If a holder crashes
 * mid-migration, Postgres releases the lock automatically when that
 * session's connection drops — a stuck lock cannot outlive its process.
 */
export async function runMigrationsWithAdvisoryLock(
  databaseUrl: string,
  ssl: boolean | TlsOptions,
): Promise<void> {
  const logger = new Logger('MigrationRunner');
  const migrationDataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    migrations: [join(__dirname, '..', 'migrations', '!(*.spec).{ts,js}')],
    migrationsTransactionMode: 'each',
    // ZT-012: caller-supplied policy from the single shared
    // `databaseSslOptions()` helper (config/database-ssl.ts) — this is the
    // connection that opens FIRST on any boot, before the runtime
    // DataSource exists, so it must never diverge from it.
    ssl,
    // LSA-01: TypeORM's default console logger prints failing statements
    // with every bound parameter; the safe logger writes SQLSTATE/table only.
    logger: new SafeTypeOrmLogger(['error']),
  });

  await migrationDataSource.initialize();
  const queryRunner = migrationDataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const executed = await migrationDataSource.runMigrations();
      if (executed.length > 0) {
        logger.log(
          `ran ${executed.length} migration(s): ${executed.map((m) => m.name).join(', ')}`,
        );
      }
    } finally {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [
        MIGRATION_LOCK_ID,
      ]);
    }
  } finally {
    await queryRunner.release();
    await migrationDataSource.destroy();
  }
}
