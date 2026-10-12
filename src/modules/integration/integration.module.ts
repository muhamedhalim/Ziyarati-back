import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module';
import { ServicesModule } from '../services/services.module';
import { StaffModule } from '../staff/staff.module';
import { CrmModule } from '../crm/crm.module';
import { AppointmentModule } from '../appointment/appointment.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { TenantModule } from '../tenant/tenant.module';
import { IntegrationPlatformModule } from '../integration-platform/integration-platform.module';

import { IntegrationMeController } from './integration-me.controller';
import { IntegrationServicesController } from './integration-services.controller';
import { IntegrationStaffController } from './integration-staff.controller';
import { IntegrationCustomersController } from './integration-customers.controller';
import { IntegrationAppointmentsController } from './integration-appointments.controller';
import { IntegrationAvailabilityController } from './integration-availability.controller';
import { IntegrationBranchesController } from './integration-branches.controller';
import { IntegrationWriteCustomersController } from './integration-write-customers.controller';
import { IntegrationWriteServicesController } from './integration-write-services.controller';
import { IntegrationWriteStaffController } from './integration-write-staff.controller';
import { IntegrationWriteAppointmentsController } from './integration-write-appointments.controller';

/**
 * External (machine-to-machine) integration API.
 *
 * Every controller here is a thin, tenant-scoped wrapper around an EXISTING
 * domain service (ServiceService, StaffService, CustomerService,
 * AppointmentsService, AvailabilityService) — no business logic is
 * duplicated. Each route is `@ApiKeyProtected(scope)`: API-key authenticated
 * (via the global JwtAuthGuard + ApiKeyAuthGuard — see jwt-auth.guard.ts),
 * tenant-status checked (ActiveTenantGuard), and scope-checked
 * (IntegrationScopeGuard). Read responses are strict allowlist projections
 * (see integration.mappers.ts) that never include internal metadata, medical
 * notes, payment details, or authentication data.
 *
 * Mounted at `/api/v1/integrations/*` (the existing global `api/v1` prefix
 * already provides the version marker — no `app.enableVersioning()` change).
 *
 * Phase 1 exposed read-only endpoints. Phase 3 adds the two M2M WRITE/upsert
 * controllers (customers, services), which delegate to the shared write
 * pipeline in IntegrationPlatformModule (idempotency + external-id mapping +
 * source-of-truth/protected-field enforcement) — still no business logic here.
 */
@Module({
  imports: [
    PlatformModule,
    ServicesModule,
    StaffModule,
    CrmModule,
    AppointmentModule,
    SchedulingModule,
    // Read-only branch discovery (BranchService).
    TenantModule,
    // Phase 3 — provides IntegrationWriteService for the M2M write controllers.
    IntegrationPlatformModule,
  ],
  controllers: [
    // Credential self-check — valid key, no particular scope.
    IntegrationMeController,
    IntegrationServicesController,
    IntegrationStaffController,
    IntegrationCustomersController,
    IntegrationAppointmentsController,
    IntegrationAvailabilityController,
    IntegrationBranchesController,
    // Phase 3 — external (M2M) write/upsert endpoints.
    IntegrationWriteCustomersController,
    IntegrationWriteServicesController,
    // Phase 4 — staff upsert (update/link only; never creates an account).
    IntegrationWriteStaffController,
    IntegrationWriteAppointmentsController,
  ],
})
export class IntegrationModule {}
