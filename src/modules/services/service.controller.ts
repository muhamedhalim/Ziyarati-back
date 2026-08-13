import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ServiceService } from './service.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { QueryServicesDto } from './dto/query-services.dto';
import { LookupServicesDto } from './dto/lookup-services.dto';
import { AvailableServicesDto } from './dto/available-services.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * Services — the clinic's bookable catalog. Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id always from TenantContext (never request input).
 * This catalog is the source of truth that Appointments and Staff validate
 * against (read-only) at booking / assignment time.
 */
@ApiTags('Services')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.SERVICES)
@Controller('services')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ServiceController {
  constructor(
    private readonly services: ServiceService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List services',
    description:
      '**Protected — `services.read`. Clinic active.** Tenant-scoped. Filters: `search` (name), `categoryId`, `isActive`, `minDuration`/`maxDuration`, `minPrice`/`maxPrice`. Sort: `sortBy` ∈ {name, base_price, duration_minutes, created_at}, `sortOrder` ∈ {ASC, DESC}. Paginated.',
  })
  @ApiOkResponse({
    description:
      'Paginated services: `{ data, total, page, limit }` (each item includes its `category`).',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.SERVICES_READ)
  list(@Query() query: QueryServicesDto) {
    return this.services.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Service lookup (selector projection)',
    description:
      '**Protected — `services.read`. Clinic active.** Lightweight, active-only projection for dropdowns/typeaheads — returns `{ id, name, duration_minutes, base_price }[]`. Optional `search` (name) and `limit` (≤200). Not paginated. Consumed by Appointment booking, Staff assignment, and any future service selector.',
  })
  @ApiOkResponse({
    description:
      'Array of `{ id, name, duration_minutes, base_price }` (active services only).',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('lookup')
  @RequirePermissions(PERMISSION.SERVICES_READ)
  lookup(@Query() query: LookupServicesDto) {
    return this.services.lookup(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Available services (booking selector)',
    description:
      '**Protected — `services.read`. Clinic active.** Active services narrowed for booking. Filters: `staffId` (only services that staff can perform, via `staff_services`), `categoryId`, `search`, `limit` (≤200). Returns the compact `{ id, name, duration_minutes, base_price }[]` projection. Preferred over the full catalog for Appointment / AI / WhatsApp booking. `branchId` is not yet supported (no service↔branch model).',
  })
  @ApiOkResponse({
    description:
      'Array of `{ id, name, duration_minutes, base_price }` (active, booking-eligible).',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('available')
  @RequirePermissions(PERMISSION.SERVICES_READ)
  available(@Query() query: AvailableServicesDto) {
    return this.services.available(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Service catalog statistics',
    description:
      '**Protected — `services.read`. Clinic active.** Aggregate counts for dashboards: `{ total, active, inactive, categories }`. Avoids paginated list queries just to show totals.',
  })
  @ApiOkResponse({ description: '`{ total, active, inactive, categories }`.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('stats')
  @RequirePermissions(PERMISSION.SERVICES_READ)
  stats() {
    return this.services.stats(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get a service',
    description:
      "**Protected — `services.read`. Clinic active.** Includes the owning category. Another tenant's service returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Service UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Service details.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Service not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.SERVICES_READ)
  getDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.services.getDetails(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Create a service',
    description:
      '**Protected — `services.create`. Clinic active.** `name` is unique per tenant (409). `durationMinutes` must be > 0. `categoryId`, when given, must be an active category owned by the same tenant (422 if inactive, 404 if not found).',
  })
  @ApiCreatedResponse({ description: 'Service created (includes `category`).' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.create`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Referenced category not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Duplicate service name.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Referenced category is inactive.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.SERVICES_CREATE)
  create(@Body() dto: CreateServiceDto) {
    return this.services.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Update a service',
    description:
      '**Protected — `services.update`. Clinic active.** Partial update; name uniqueness and category validity re-checked when changed. Pass `categoryId: null` to detach the category.',
  })
  @ApiParam({
    name: 'id',
    description: 'Service UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Service updated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Service or referenced category not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Duplicate service name.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Referenced category is inactive.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.SERVICES_UPDATE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.services.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Activate a service',
    description:
      '**Protected — `services.update`. Clinic active.** Sets `is_active = true` so the service becomes bookable.',
  })
  @ApiParam({
    name: 'id',
    description: 'Service UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Service activated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Service not found in this tenant.',
    schema: S_ERROR,
  })
  @Patch(':id/activate')
  @RequirePermissions(PERMISSION.SERVICES_UPDATE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.services.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Deactivate a service',
    description:
      '**Protected — `services.update`. Clinic active.** Sets `is_active = false`. Existing appointments are unaffected (price/duration were snapshotted at booking); new bookings reject this service.',
  })
  @ApiParam({
    name: 'id',
    description: 'Service UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Service deactivated.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.update`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Service not found in this tenant.',
    schema: S_ERROR,
  })
  @Patch(':id/deactivate')
  @RequirePermissions(PERMISSION.SERVICES_UPDATE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.services.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Delete a service (soft, reference-guarded)',
    description:
      '**Protected — `services.delete`. Clinic active.** Soft-deletes the service (`deleted_at`), preserving historical appointment line-items. **Rejected with 409** when the service has upcoming (future, non-terminal) appointments or is still assigned to any staff — deactivate it instead. The 409 `context` carries `upcomingAppointments` / `staffAssignments` counts.',
  })
  @ApiParam({
    name: 'id',
    description: 'Service UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Service soft-deleted: `{ id, deleted: true }`.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `services.delete`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Service not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description:
      'Service has upcoming appointments or active staff assignments.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.SERVICES_DELETE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.services.remove(this.ctx.requireTenantId(), id);
  }
}
