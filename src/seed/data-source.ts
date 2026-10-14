import 'reflect-metadata';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';

import { SafeTypeOrmLogger } from '../common/logging/typeorm-safe-logger';

// Load .env before reading any connection settings.
dotenv.config();

/**
 * A standalone TypeORM DataSource for CLI scripts (seeders, migrations).
 * Deliberately independent of the NestJS DI container.
 *
 * Every entity is loaded via glob so cross-module relations (e.g. Role → Tenant)
 * resolve correctly. `synchronize` is always off — the schema is owned by the
 * canonical SQL / migrations, never by these scripts.
 *
 * Connection resolution (fixed 2026-08-08 — specs/006-platform-performance-audit
 * T019/T020, see reports/environments.md): `DATABASE_URL` takes precedence
 * when set, exactly like `src/config/typeorm.config.ts`'s runtime factory
 * does for the API/worker. Previously this DataSource read only the discrete
 * `DB_HOST`/`DB_PORT`/`DB_NAME` vars and silently ignored `DATABASE_URL`
 * entirely — so a seed script run with `DATABASE_URL` pointed at an isolated
 * database (exactly what quickstart.md's own procedure instructs) silently
 * fell back to whatever `DB_HOST`/`DB_PORT`/`DB_NAME` were in `.env` instead,
 * writing fixture data into that database without any indication of the
 * mismatch. Falls back to the discrete vars when `DATABASE_URL` is unset, so
 * this is backward-compatible with any existing invocation that never set it.
 */
const databaseUrl = process.env.DATABASE_URL;

const connectionOptions: DataSourceOptions = databaseUrl
  ? { type: 'postgres', url: databaseUrl }
  : {
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'ziyarati',
    };

export const SeedDataSource = new DataSource({
  ...connectionOptions,
  // `!(*.spec)` exclusion matches `typeorm.config.ts`'s runtime entities glob
  // (same collision: `require()`-ing a `*.spec.ts` file outside Jest hits a
  // bare `describe is not defined`, since ts-node loads it as a plain module
  // rather than a Jest test file). Without this, `npm run seed` crashes on
  // any checkout that has an `entities/**/*.spec.ts` file.
  entities: [join(__dirname, '..', 'entities', '**', '!(*.spec).{ts,js}')],
  synchronize: false,
  // LSA-01: never TypeORM's parameter-printing console logger.
  logger: new SafeTypeOrmLogger(
    process.env.DB_LOGGING === 'true' ? ['query', 'error', 'warn'] : ['error'],
  ),
});
