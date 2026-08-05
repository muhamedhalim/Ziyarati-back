import { DataSource } from 'typeorm';
import { join } from 'node:path';

// Invoke the migration CLI with env preloaded, e.g.
//   node -r dotenv/config ./node_modules/typeorm/cli.js migration:run -d dist/config/data-source.js

/**
 * Standalone TypeORM DataSource for the migration CLI (e.g.
 * `typeorm migration:run -d dist/config/data-source.js`). The runtime app wires
 * TypeORM via `typeOrmFactory`; this exists only so migrations can be generated
 * and run outside the Nest container.
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  // See typeorm.config.ts for why this excludes *.spec — same loader, same gotcha.
  entities: [join(__dirname, '..', 'entities', '**', '!(*.spec).{ts,js}')],
  migrations: [join(__dirname, '..', 'migrations', '!(*.spec).{ts,js}')],
  // Matches run-migrations-with-lock.ts and scripts/verify-migrations.ts:
  // TypeORM's default ('all') forbids any individual migration from
  // overriding `transaction`, which the CONCURRENTLY-based migrations need
  // (CREATE INDEX CONCURRENTLY cannot run inside a transaction block).
  migrationsTransactionMode: 'each',
  synchronize: false,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
