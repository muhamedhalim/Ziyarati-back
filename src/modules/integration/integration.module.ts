import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module';
import { ServicesModule } from '../services/services.module';
import { StaffModule } from '../staff/staff.module';
import { CrmModule } from '../crm/crm.module';
import { AppointmentModule } from '../appointment/appointment.module';
import { SchedulingModule } from '../scheduling/scheduling.module';

import { IntegrationServicesController } from './integration-services.controller';
import { IntegrationStaffController } from './integration-staff.controller';
import { IntegrationCustomersController } from './integration-customers.controller';
import { IntegrationAppointmentsController } from './integration-appointments.controller';
import { IntegrationAvailabilityController } from './integration-availability.controller';

/**
 * External (machine-to-machine) integration API — Phase 1, read-only.
 *
 * Every controller here is a thin, tenant-scoped wrapper around an EXISTING
 * domain service (ServiceService, StaffService, CustomerService,
 * AppointmentsService, AvailabilityService) — no business logic is
 * duplicated. Each route is `@ApiKeyProtected(scope)`: API-key authenticated
 * (via the global JwtAuthGuard + ApiKeyAuthGuard — see jwt-auth.guard.ts),
 * tenant-status checked (ActiveTenantGuard), and scope-checked
 * (IntegrationScopeGuard). Responses are strict allowlist projections (see
 * integration.mappers.ts) that never include internal metadata, medical
 * notes, payment details, or authentication data.
 *
 * Mounted at `/api/v1/integrations/*` (the existing global `api/v1` prefix
 * already provides the version marker — no `app.enableVersioning()` change).
 *
 * Deliberately NOT included in Phase 1 (see the audit): webhooks, data
 * import/sync, external-ID mapping. Only resources with a safe, already
 * tenant-scoped, read-only service are exposed.
 */
@Module({
  imports: [
    PlatformModule,
    ServicesModule,
    StaffModule,
    CrmModule,
    AppointmentModule,
    SchedulingModule,
  ],
  controllers: [
    IntegrationServicesController,
    IntegrationStaffController,
    IntegrationCustomersController,
    IntegrationAppointmentsController,
    IntegrationAvailabilityController,
  ],
})
export class IntegrationModule {}
