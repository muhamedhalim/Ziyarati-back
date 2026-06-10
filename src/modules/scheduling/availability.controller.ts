import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AvailabilityService } from './availability.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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
 * Availability engine endpoints (read-only). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id always from TenantContext. The service enforces
 * the per-operation required query params and validates branch/staff ownership.
 */
@ApiTags('Scheduling Availability')
@ApiBearerAuth('JWT-auth')
@Controller('scheduling/availability')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Check availability of a window',
    description: '**Protected — `scheduling.availability.read`. Clinic active.** Requires `branchId`, `staffId`, `startTime`, `endTime`. Returns availability + conflict breakdown (holiday/blocked/occupied/outside-slot).',
  })
  @ApiOkResponse({ description: 'Availability result.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.availability.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch or staff not found in this tenant.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Invalid time range.', schema: S_ERROR })
  @Get('check')
  @RequirePermissions(PERMISSION.SCHEDULING_AVAILABILITY_READ)
  check(@Query() query: AvailabilityQueryDto) {
    return this.availability.check(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get available windows for a day',
    description: '**Protected — `scheduling.availability.read`. Clinic active.** Requires `branchId`, `staffId`, `date`. Returns free windows (slots minus blocks/appointments), optionally chunked by `slotMinutes`. Holidays return an empty set.',
  })
  @ApiOkResponse({ description: 'Available windows.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.availability.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch or staff not found in this tenant.', schema: S_ERROR })
  @Get('windows')
  @RequirePermissions(PERMISSION.SCHEDULING_AVAILABILITY_READ)
  windows(@Query() query: AvailabilityQueryDto) {
    return this.availability.windows(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Availability summary for a day',
    description: '**Protected — `scheduling.availability.read`. Clinic active.** Requires `branchId`, `date` (`staffId` optional). Returns available / blocked / holiday / occupied facets for the day.',
  })
  @ApiOkResponse({ description: 'Availability summary.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.availability.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch or staff not found in this tenant.', schema: S_ERROR })
  @Get('summary')
  @RequirePermissions(PERMISSION.SCHEDULING_AVAILABILITY_READ)
  summary(@Query() query: AvailabilityQueryDto) {
    return this.availability.summary(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Validate booking availability',
    description: '**Protected — `scheduling.availability.read`. Clinic active.** Requires `branchId`, `staffId`, `startTime`, `endTime`. Returns `{ valid, reasons[] }` — the check the Appointment module runs before creating a booking.',
  })
  @ApiOkResponse({ description: 'Validation result.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `scheduling.availability.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Branch or staff not found in this tenant.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Invalid time range.', schema: S_ERROR })
  @Get('validate')
  @RequirePermissions(PERMISSION.SCHEDULING_AVAILABILITY_READ)
  validate(@Query() query: AvailabilityQueryDto) {
    return this.availability.validate(this.ctx.requireTenantId(), query);
  }
}
