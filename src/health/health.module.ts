import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, type ClientConfig } from 'pg';

import {
  HealthController,
  READINESS_DB_CLIENT_FACTORY,
} from './health.controller';
import { databaseSslOptions } from '../config/database-ssl';

/**
 * Health endpoints. Depends only on the global QueueService for Redis + queue
 * readiness — no extra wiring needed.
 *
 * P1.4 — provides the REAL {@link READINESS_DB_CLIENT_FACTORY}: a plain
 * `pg.Client` (never TypeORM's pool — see `HealthController`'s own
 * docstring for why), constructed fresh on every call so a dropped
 * connection reconnects cleanly. `useFactory` here returns the FACTORY
 * FUNCTION itself (not a client) — the controller calls it lazily, once, on
 * first use, and again only if the connection is later lost.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_DB_CLIENT_FACTORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => () => {
        const databaseUrl = config.getOrThrow<string>('DATABASE_URL');
        const ssl = databaseSslOptions({
          NODE_ENV: config.get<string>('NODE_ENV'),
          DB_SSL_CA: config.get<string>('DB_SSL_CA'),
          DB_SSL_CA_CERT: config.get<string>('DB_SSL_CA_CERT'),
        });
        // Typing only: `@types/pg` (pulled in by the optional OpenTelemetry pg
        // instrumentation) narrows `ssl` to tls.ConnectionOptions; the value is unchanged.
        return new Client({ connectionString: databaseUrl, ssl: ssl as ClientConfig['ssl'] });
      },
    },
  ],
})
export class HealthModule {}
