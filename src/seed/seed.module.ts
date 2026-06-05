import { Module } from '@nestjs/common';
import { BootstrapSeederService } from './bootstrap-seeder.service';

/**
 * Wires the idempotent startup seeder into the application. The DataSource is
 * provided globally by TypeOrmModule.forRootAsync (AppModule), so no
 * forFeature/forRoot import is needed here.
 */
@Module({
  providers: [BootstrapSeederService],
})
export class SeedModule {}
