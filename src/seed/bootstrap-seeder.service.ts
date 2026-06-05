import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runSeeders } from './index.seed';

/**
 * Runs the RBAC + super-admin seeders once the application has finished
 * bootstrapping — i.e. AFTER TypeORM has connected and (in dev) synchronized
 * the schema, so the tables are guaranteed to exist.
 *
 * Crucially this uses the application's OWN DataSource (the DATABASE_URL
 * connection), so seeding always targets exactly the database the app reads —
 * eliminating the "seeded a different DB" class of bug that a standalone script
 * with its own connection settings can cause.
 *
 * Seeding is idempotent, so running on every boot is safe. Disable with
 * SEED_ON_STARTUP=false (recommended in production, where the super-admin is
 * provisioned once via `npm run seed` or a migration).
 */
@Injectable()
export class BootstrapSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BootstrapSeeder');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const enabled =
      this.config.get<string>('SEED_ON_STARTUP', 'true') !== 'false';

    if (!enabled) {
      this.logger.log('Startup seeding disabled (SEED_ON_STARTUP=false)');
      return;
    }

    try {
      await runSeeders(this.dataSource);
      this.logger.log('Startup seeding completed ✅');
    } catch (err) {
      // Never crash the app because seeding failed — just surface it loudly.
      this.logger.error(
        'Startup seeding failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
