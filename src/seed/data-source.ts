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
  entities: [join(__dirname, '..', 'entities', '**', '*.{ts,js}')],
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
});
