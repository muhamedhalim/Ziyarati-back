import 'reflect-metadata';
import { join } from 'path';
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

// Load .env before reading any connection settings.
dotenv.config();

/**
 * A standalone TypeORM DataSource for CLI scripts (seeders, migrations).
 * Deliberately independent of the NestJS DI container.
 *
 * Every entity is loaded via glob so cross-module relations (e.g. Role → Tenant)
 * resolve correctly. `synchronize` is always off — the schema is owned by the
 * canonical SQL / migrations, never by these scripts.
 */
export const SeedDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'ziyarati',
  // `!(*.spec)` exclusion matches `typeorm.config.ts`'s runtime entities glob
  // (same collision: `require()`-ing a `*.spec.ts` file outside Jest hits a
  // bare `describe is not defined`, since ts-node loads it as a plain module
  // rather than a Jest test file). Without this, `npm run seed` crashes on
  // any checkout that has an `entities/**/*.spec.ts` file.
  entities: [join(__dirname, '..', 'entities', '**', '!(*.spec).{ts,js}')],
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});
