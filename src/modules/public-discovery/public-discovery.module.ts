import { Module } from '@nestjs/common';

import { PublicDiscoveryService } from './public-discovery.service';
import { PublicDiscoveryController } from './public-discovery.controller';

/**
 * Public (anonymous) clinic discovery for the website chat widget. Read-only,
 * raw DataSource queries over existing tenant/branch/service/staff tables — no
 * new entities, no business-logic duplication.
 */
@Module({
  controllers: [PublicDiscoveryController],
  providers: [PublicDiscoveryService],
  exports: [PublicDiscoveryService],
})
export class PublicDiscoveryModule {}
