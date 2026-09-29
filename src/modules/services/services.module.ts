import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Service } from '../../entities/Services/Service';
import { ServiceCategory } from '../../entities/Services/ServiceCategory';
import { AppointmentService } from '../../entities/Calendar&Appointments/AppointmentService';
import { StaffService } from '../../entities/Staff/StaffService';

import { ServiceService } from './service.service';
import { ServiceCategoryService } from './service-category.service';
import { ServiceImportService } from './service-import.service';

import { ServiceController } from './service.controller';
import { ServiceCategoryController } from './service-category.controller';
import { ServiceImportController } from './service-import.controller';

/**
 * Service Catalog Domain — the central source of truth for every bookable
 * service a clinic offers.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions
 * with the existing `services.*` permission family), ActiveTenantGuard +
 * TenantContextService (tenant scope), the global JwtAuthGuard, and
 * @RequireActiveSubscription. Every resource is strictly tenant-scoped via the
 * `tenant` relation; the tenant always comes from TenantContext, never request
 * input.
 *
 * Relationship map: ServiceCategory 1:N Service. Appointments and Staff consume
 * this catalog READ-ONLY (they validate `serviceIds` against `services` and
 * snapshot price/duration) — those modules keep their own `forFeature(Service)`
 * registration and are intentionally NOT modified here; this module only adds
 * the missing write path. ServiceService is exported so future consumers can
 * reuse catalog logic without re-registering the entity.
 *
 * Controller order matters: ServiceCategoryController is registered BEFORE
 * ServiceController so the static `services/categories` path is never shadowed
 * by the `services/:id` param route. ServiceImportController (`services/import/*`)
 * is registered before ServiceController for the same reason.
 */
@Module({
  imports: [
    // Service + ServiceCategory are owned here. AppointmentService and
    // StaffService are registered read-only so the delete-guard can count
    // upcoming bookings / active staff assignments before retiring a service.
    TypeOrmModule.forFeature([Service, ServiceCategory, AppointmentService, StaffService]),
  ],
  controllers: [ServiceCategoryController, ServiceImportController, ServiceController],
  providers: [ServiceService, ServiceCategoryService, ServiceImportService],
  exports: [ServiceService, ServiceCategoryService],
})
export class ServicesModule {}
