import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'node:path';

/**
 * Shared TypeORM configuration factory.
 *
 * Extracted from AppModule so BOTH process roots — the HTTP API (`main.ts`) and
 * the BullMQ worker (`worker.ts`) — use byte-identical database wiring. Behavior
 * is unchanged from the original inline factory; only the entities glob is made
 * relative to this file's new location (`config/` → `../entities`).
 */
export function typeOrmFactory(config: ConfigService): TypeOrmModuleOptions {
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

  return {
    type: 'postgres',
    url: databaseUrl,
    autoLoadEntities: true,
    entities: [join(__dirname, '..', 'entities', '**', '*.{ts,js}')],
    migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],
    synchronize,
    migrationsRun: !synchronize,
    logging: logging ? ['query', 'error', 'warn'] : ['error'],
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    extra: {
      max: config.get<number>('DB_POOL_MAX', 10) ?? 10,
      min: config.get<number>('DB_POOL_MIN', 1) ?? 1,
      idleTimeoutMillis: config.get<number>('DB_POOL_IDLE_TIMEOUT', 30000),
    },
  } as TypeOrmModuleOptions;
}
