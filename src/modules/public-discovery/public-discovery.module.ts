import { Module } from '@nestjs/common';

import { SchedulingModule } from '../scheduling/scheduling.module';

import { PublicDiscoveryService } from './public-discovery.service';
import { PublicDiscoveryController } from './public-discovery.controller';

/**
 * Public (anonymous) clinic discovery for the website chat widget. Read-only,
 * raw DataSource queries over existing tenant/branch/service/staff tables — no
 * new entities, no business-logic duplication. Free-slot lookups reuse the
 * tenant's own AvailabilityService (SchedulingModule).
 */
@Module({
  imports: [SchedulingModule],
  controllers: [PublicDiscoveryController],
  providers: [PublicDiscoveryService],
  exports: [PublicDiscoveryService],
})
export class PublicDiscoveryModule {}
